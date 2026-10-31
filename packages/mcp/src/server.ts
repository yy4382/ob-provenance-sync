import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { noteSchema, slug, type AgentId, type OpRequest, type OpResponse } from "@provenance/core";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

export type OpsTransport = (req: OpRequest) => Promise<OpResponse>;
export type Mode = "full" | "limited";

function instructions(mode: Mode): string {
  const full = mode === "full";
  return [
    "Use this server for anything in the human's Obsidian vault: notes, journals, daily notes, and questions about what they wrote. It records who wrote every character. The human sees this as colors and hover details in Obsidian.",
    "",
    "Writing",
    '- Change notes only through these tools. Text you write with your own file tools is recorded as "unknown", even if you can reach the vault on disk.',
    "- Change existing text with edit_file or append_to_file. Deleting and recreating a note loses its authors.",
    "- Each write has one why. If content mixes your words and the human's, make separate calls.",
    "- why=human-via-agent is only for the human's exact words, including words you move unchanged. Anything you reworded, summarized, translated or corrected is why=agent.",
    "- Deleted text leaves no trace, and there is no undo tool. Don't remove the human's text unless they asked.",
    "- Fixing one word in a human sentence marks the whole sentence as mixed. Avoid edits the human didn't ask for.",
    "",
    "Reading",
    "- Use read_file with provenance=true before rewriting existing text, or when asked who wrote something.",
    "",
    "Finding notes",
    `- Don't guess paths. Wikilinks like [[Note]] are not paths. Use ${full ? "search, list_files, get_links or get_backlinks" : "list_files"}.`,
    "- If AGENTS.md exists at the vault root, read it before your first write. It holds this vault's conventions.",
    full ? "- For today's journal, use get_daily_note." : "- If AGENTS.md doesn't say where daily notes live, ask the human.",
    "",
    "Errors",
    ...(full ? ["- If a tool says Obsidian isn't running, ask the human to open it instead of retrying. Reading, listing, editing, appending and creating may still work."] : []),
    "- After an unavailable error on a write, read the note before retrying, because the change may have landed.",
  ].join("\n");
}

const why = z
  .enum(["agent", "human-via-agent"])
  .describe(
    "agent: anything you wrote, reworded, summarized, translated or corrected. " +
      "human-via-agent: only the human's exact words, including words you move unchanged.",
  );
const note = noteSchema.optional().describe("Optional reason for this change, shown to the human on hover. One line, at most 200 characters. Add one when the reason isn't obvious.");
const path = z.string().describe("Exact, case-sensitive vault path including .md, with no leading slash, e.g. notes/today.md");

function render(res: OpResponse): CallToolResult {
  if (!res.ok) return { isError: true, content: [{ type: "text", text: `${res.code}: ${res.message}` }] };
  const r = res.result;
  let text: string;
  switch (r.op) {
    case "list":
      text = r.files.join("\n") || "(no files)";
      break;
    case "read":
      text = r.sentences
        ? r.sentences.map((s) => `[${s.kind}${s.authors.length && s.kind !== "unknown" ? ` ${s.authors.join(",")}` : ""}] ${s.text}`).join("\n")
        : r.content;
      break;
    case "edit":
      text = `replaced ${r.replaced} occurrence(s)`;
      break;
    case "links":
    case "backlinks":
    case "search":
      text = r.paths.join("\n") || "(none)";
      break;
    case "rename":
      text = r.linksPending ? "renamed. Links from other notes are not updated yet: Obsidian is asking the human whether to update them." : "ok";
      break;
    case "daily":
      text = r.path;
      break;
    default:
      text = "ok";
  }
  return { content: [{ type: "text", text }] };
}

/** The identity an MCP client announces in its handshake, e.g. "Claude Code" becomes agent:claude-code. */
export function agentFromClientName(client: string | undefined): AgentId | null {
  const name = slug(client ?? "");
  return name ? `agent:${name}` : null;
}

/**
 * Exposes vault ops as MCP tools. Limited mode is the subset a server can
 * serve without Obsidian; full mode adds the tools that need Obsidian's
 * metadata cache and file operations.
 *
 * Edits are attributed to `agent` when it is pinned, otherwise to the name
 * the client gave in the MCP handshake, so several agents can share one
 * server configuration and still be told apart.
 */
export function createMcpServer(opts: { ops: OpsTransport; agent: AgentId | null; mode: Mode }): McpServer {
  const server = new McpServer({ name: "obsidian-provenance", version: pkg.version }, { instructions: instructions(opts.mode) });
  const call = async (req: OpRequest) => render(await opts.ops(req));
  const identity = () => opts.agent ?? agentFromClientName(server.server.getClientVersion()?.name);
  const by = (w: z.infer<typeof why>, n?: string) => ({ agent: identity()!, why: w, ...(n ? { note: n } : {}) });
  const write = async (req: OpRequest) => {
    if (!identity()) return render({ ok: false, code: "invalid", message: "this MCP client sent no name; start the server with --agent <name>" });
    return call(req);
  };

  server.registerTool(
    "list_files",
    {
      description: "List vault files, including attachments. Only .md files can be read or edited. In a large vault, pass prefix.",
      inputSchema: { prefix: z.string().optional().describe("Only list paths starting with this string. End it with / to match a folder.") },
      annotations: { readOnlyHint: true },
    },
    ({ prefix }) => call({ op: "list", ...(prefix ? { prefix } : {}) }),
  );
  server.registerTool(
    "read_file",
    {
      description:
        'Read a markdown file. With provenance=true, text is split at sentence ends and line breaks, and each piece is printed as "[kind authors] text". ' +
        "Kinds: human (typed by a human), via-agent (the human's words inserted by an agent), agent (an agent's own words), unknown (no recorded author), " +
        "mixed (agent words combined with human or dictated words). Authors are listed in text order. " +
        'An author of "unknown" means part of the piece has no recorded author. Example: "[mixed human:alice,agent:claude-code] Half half." ' +
        "This view shows no notes or times, and drops indentation and blank lines, so copy old_string from a plain read.",
      inputSchema: { path, provenance: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ path, provenance }) => call({ op: "read", path, provenance: provenance ?? false }),
  );
  server.registerTool(
    "edit_file",
    {
      description:
        "Replace an exact string in a markdown file. old_string must match exactly once, or the call fails and changes nothing. " +
        "replace_all replaces every match. An empty new_string deletes the text. " +
        "Unchanged text keeps its author, except punctuation and spaces between your changes. " +
        "If the match fails, read the note again, because the human may have changed it.",
      inputSchema: {
        path,
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
        why,
        note,
      },
    },
    (a) =>
      write({
        op: "edit",
        path: a.path,
        oldString: a.old_string,
        newString: a.new_string,
        replaceAll: a.replace_all ?? false,
        by: by(a.why, a.note),
      }),
  );
  server.registerTool(
    "append_to_file",
    {
      description: "Append text to the end of an existing markdown file. Include any leading newline you need.",
      inputSchema: { path, text: z.string(), why, note },
    },
    (a) => write({ op: "append", path: a.path, text: a.text, by: by(a.why, a.note) }),
  );
  server.registerTool(
    "create_file",
    {
      description: "Create a new markdown file and any missing folders. Fails if the file already exists.",
      inputSchema: { path, content: z.string(), why, note },
    },
    (a) => write({ op: "create", path: a.path, content: a.content, by: by(a.why, a.note) }),
  );

  if (opts.mode === "limited") return server;

  server.registerTool(
    "rename_file",
    {
      description:
        "Rename or move a markdown file, not a folder, creating any missing folders. Attribution is kept, and nothing records who renamed it. " +
        "Links from other notes update only if the human allows it, and the result says when that's pending. " +
        "Link text rewritten this way becomes author unknown. Requires Obsidian running.",
      inputSchema: { from: path, to: path },
    },
    ({ from, to }) => call({ op: "rename", from, to }),
  );
  server.registerTool(
    "delete_file",
    {
      description:
        "Delete a markdown file using the vault's deleted-files setting, which may be the system trash, the .trash folder or permanent deletion. " +
        "Nothing records who deleted it, and a restored note loses its attribution. Ask the human first unless they requested this deletion. Requires Obsidian running.",
      inputSchema: { path },
      annotations: { destructiveHint: true },
    },
    ({ path }) => call({ op: "delete", path }),
  );
  server.registerTool(
    "get_links",
    {
      description: "List the existing notes and attachments this note links to. Links to missing notes are left out. Requires Obsidian running.",
      inputSchema: { path },
      annotations: { readOnlyHint: true },
    },
    ({ path }) => call({ op: "links", path }),
  );
  server.registerTool(
    "get_backlinks",
    { description: "List notes that link to this note. Requires Obsidian running.", inputSchema: { path }, annotations: { readOnlyHint: true } },
    ({ path }) => call({ op: "backlinks", path }),
  );
  server.registerTool(
    "search",
    {
      description:
        "Search note contents and paths. This is not regex or Obsidian search syntax, and quotes are literal. " +
        "Matching ignores case, and every space-separated word must appear as a substring, either all in the path or all in the content. " +
        "Returns paths only, at most 50, with no sign of truncation. If you get 50, use a narrower query. Requires Obsidian running.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => call({ op: "search", query }),
  );
  server.registerTool(
    "get_daily_note",
    {
      description:
        "Return the path of today's daily note, creating it from the vault's template if needed. Use this instead of guessing the path. " +
        "Fails if the Daily notes plugin is off or its folder doesn't exist. A new note starts as author unknown. Requires Obsidian running.",
      inputSchema: {},
    },
    () => call({ op: "daily" }),
  );
  return server;
}
