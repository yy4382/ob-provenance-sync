import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NOTE_MAX_LENGTH, type AgentId, type OpRequest, type OpResponse } from "@provenance/core";
import { z } from "zod";

export type OpsTransport = (req: OpRequest) => Promise<OpResponse>;
export type Mode = "full" | "limited";

const why = z
  .enum(["agent", "human-via-agent"])
  .describe(
    "agent: you wrote this content yourself (your own observation, summary or idea). " +
      "human-via-agent: you are inserting words the human dictated or explicitly asked to be written verbatim.",
  );
const note = z
  .string()
  .max(NOTE_MAX_LENGTH)
  .optional()
  .describe("Optional one-sentence reason for this change, shown to the human on hover.");
const path = z.string().describe("Vault-relative path of a markdown file, e.g. notes/today.md");

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
        ? r.sentences.map((s) => `[${s.kind}${s.authors.length ? ` ${s.authors.join(",")}` : ""}] ${s.text}`).join("\n")
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
    default:
      text = "ok";
  }
  return { content: [{ type: "text", text }] };
}

/** The identity an MCP client announces in its handshake, e.g. "Claude Code" becomes agent:claude-code. */
export function agentFromClientName(name: string | undefined): AgentId | null {
  const slug = (name ?? "").toLowerCase().replace(/[^\w.@-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `agent:${slug}` : null;
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
  const server = new McpServer({ name: "obsidian-provenance", version: "0.1.0" });
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
      description: "List markdown files in the Obsidian vault.",
      inputSchema: { prefix: z.string().optional().describe("Only list paths starting with this folder prefix") },
      annotations: { readOnlyHint: true },
    },
    ({ prefix }) => call({ op: "list", ...(prefix ? { prefix } : {}) }),
  );
  server.registerTool(
    "read_file",
    {
      description:
        "Read a markdown file. With provenance=true each sentence is prefixed with who wrote it " +
        "(human, via-agent, agent, unknown or mixed).",
      inputSchema: { path, provenance: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ path, provenance }) => call({ op: "read", path, provenance: provenance ?? false }),
  );
  server.registerTool(
    "edit_file",
    {
      description:
        "Replace an exact string in a markdown file. old_string must match exactly once unless replace_all is set. " +
        "Only the characters that differ are attributed to you.",
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
      description: "Append text to the end of a markdown file. Include any leading newline you need.",
      inputSchema: { path, text: z.string(), why, note },
    },
    (a) => write({ op: "append", path: a.path, text: a.text, by: by(a.why, a.note) }),
  );
  server.registerTool(
    "create_file",
    {
      description: "Create a new markdown file. Fails if the file already exists.",
      inputSchema: { path, content: z.string(), why, note },
    },
    (a) => write({ op: "create", path: a.path, content: a.content, by: by(a.why, a.note) }),
  );

  if (opts.mode === "limited") return server;

  server.registerTool(
    "rename_file",
    { description: "Rename or move a markdown file. Requires Obsidian running.", inputSchema: { from: path, to: path } },
    ({ from, to }) => call({ op: "rename", from, to }),
  );
  server.registerTool(
    "delete_file",
    {
      description: "Delete a markdown file (moved to Obsidian's trash). Requires Obsidian running.",
      inputSchema: { path },
      annotations: { destructiveHint: true },
    },
    ({ path }) => call({ op: "delete", path }),
  );
  server.registerTool(
    "get_links",
    { description: "List notes this note links to. Requires Obsidian running.", inputSchema: { path }, annotations: { readOnlyHint: true } },
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
      description: "Search note contents and names. Requires Obsidian running.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => call({ op: "search", query }),
  );
  return server;
}
