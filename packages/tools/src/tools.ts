import { FULL_ONLY_OPS, noteSchema, type AgentId, type OpName, type OpRequest, type OpResponse } from "@provenance/core";
import { z } from "zod";
import type { Mode } from "./instructions";
import { render, type Rendered } from "./render";

export type OpsTransport = (req: OpRequest) => Promise<OpResponse>;

const why = z
  .enum(["agent", "human-via-agent"])
  .describe(
    "agent: anything you wrote, reworded, summarized, translated or corrected. " +
      "human-via-agent: only the human's exact words, including words you move unchanged.",
  );
const note = noteSchema.optional().describe("Optional reason for this change, shown to the human on hover. One line, at most 200 characters. Add one when the reason isn't obvious.");
const path = z.string().describe("Exact, case-sensitive vault path including .md, with no leading slash, e.g. notes/today.md");

type WriteArgs = { why: z.infer<typeof why>; note?: string | undefined };
const by = (a: WriteArgs, agent: AgentId) => ({ agent, why: a.why, ...(a.note ? { note: a.note } : {}) });

/** One vault operation as an agent sees it. Field names in `input` are also the CLI's key= names. */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  mcpName: string;
  command: string;
  op: OpName;
  description: string;
  input: S;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  /** `agent` is set for any tool whose input has `why`, the ones that record an author. */
  request(args: z.output<z.ZodObject<S>>, agent: AgentId): OpRequest;
}

const tool = <S extends z.ZodRawShape>(def: ToolDef<S>) => def as unknown as ToolDef;

export const TOOLS: readonly ToolDef[] = [
  tool({
    mcpName: "list_files",
    command: "list",
    op: "list",
    description: "List vault files, including attachments. Only .md files can be read or edited. In a large vault, pass prefix.",
    input: { prefix: z.string().optional().describe("Only list paths starting with this string. End it with / to match a folder.") },
    annotations: { readOnlyHint: true },
    request: ({ prefix }) => ({ op: "list", ...(prefix ? { prefix } : {}) }),
  }),
  tool({
    mcpName: "read_file",
    command: "read",
    op: "read",
    description:
      'Read a markdown file. With provenance=true, text is split at sentence ends and line breaks, and each piece is printed as "[kind authors] text". ' +
      "Kinds: human (typed by a human), via-agent (the human's words inserted by an agent), agent (an agent's own words), unknown (no recorded author), " +
      "mixed (agent words combined with human or dictated words). Authors are listed in text order. " +
      'An author of "unknown" means part of the piece has no recorded author. Example: "[mixed human:alice,agent:claude-code] Half half." ' +
      "This view shows no notes or times, and drops indentation and blank lines, so copy old_string from a plain read.",
    input: { path, provenance: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    request: ({ path, provenance }) => ({ op: "read", path, provenance: provenance ?? false }),
  }),
  tool({
    mcpName: "edit_file",
    command: "edit",
    op: "edit",
    description:
      "Replace an exact string in a markdown file. old_string must match exactly once, or the call fails and changes nothing. " +
      "replace_all replaces every match. An empty new_string deletes the text. " +
      "Unchanged text keeps its author, except punctuation and spaces between your changes. " +
      "If the match fails, read the note again, because the human may have changed it.",
    input: {
      path,
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
      why,
      note,
    },
    request: (a, agent) => ({
      op: "edit",
      path: a.path,
      oldString: a.old_string,
      newString: a.new_string,
      replaceAll: a.replace_all ?? false,
      by: by(a, agent),
    }),
  }),
  tool({
    mcpName: "append_to_file",
    command: "append",
    op: "append",
    description: "Append text to the end of an existing markdown file. Include any leading newline you need.",
    input: { path, text: z.string(), why, note },
    request: (a, agent) => ({ op: "append", path: a.path, text: a.text, by: by(a, agent) }),
  }),
  tool({
    mcpName: "create_file",
    command: "create",
    op: "create",
    description: "Create a new markdown file and any missing folders. Fails if the file already exists.",
    input: { path, content: z.string(), why, note },
    request: (a, agent) => ({ op: "create", path: a.path, content: a.content, by: by(a, agent) }),
  }),
  tool({
    mcpName: "rename_file",
    command: "rename",
    op: "rename",
    description:
      "Rename or move a markdown file, not a folder, creating any missing folders. Attribution is kept, and nothing records who renamed it. " +
      "Links from other notes update only if the human allows it, and the result says when that's pending. " +
      "Link text rewritten this way becomes author unknown. Requires Obsidian running.",
    input: { from: path, to: path },
    request: ({ from, to }) => ({ op: "rename", from, to }),
  }),
  tool({
    mcpName: "delete_file",
    command: "delete",
    op: "delete",
    description:
      "Delete a markdown file using the vault's deleted-files setting, which may be the system trash, the .trash folder or permanent deletion. " +
      "Nothing records who deleted it, and a restored note loses its attribution. Ask the human first unless they requested this deletion. Requires Obsidian running.",
    input: { path },
    annotations: { destructiveHint: true },
    request: ({ path }) => ({ op: "delete", path }),
  }),
  tool({
    mcpName: "get_links",
    command: "links",
    op: "links",
    description: "List the existing notes and attachments this note links to. Links to missing notes are left out. Requires Obsidian running.",
    input: { path },
    annotations: { readOnlyHint: true },
    request: ({ path }) => ({ op: "links", path }),
  }),
  tool({
    mcpName: "get_backlinks",
    command: "backlinks",
    op: "backlinks",
    description: "List notes that link to this note. Requires Obsidian running.",
    input: { path },
    annotations: { readOnlyHint: true },
    request: ({ path }) => ({ op: "backlinks", path }),
  }),
  tool({
    mcpName: "search",
    command: "search",
    op: "search",
    description:
      "Search note contents and paths. This is not regex or Obsidian search syntax, and quotes are literal. " +
      "Matching ignores case, and every space-separated word must appear as a substring, either all in the path or all in the content. " +
      "Returns paths only, at most 50, with no sign of truncation. If you get 50, use a narrower query. Requires Obsidian running.",
    input: { query: z.string() },
    annotations: { readOnlyHint: true },
    request: ({ query }) => ({ op: "search", query }),
  }),
  tool({
    mcpName: "get_daily_note",
    command: "daily",
    op: "daily",
    description:
      "Return the path of today's daily note without creating it. Use this instead of guessing the path. " +
      "If the note doesn't exist yet, a second line says (not created yet). " +
      "Fails if the Daily notes plugin is off or its folder doesn't exist. Requires Obsidian running.",
    input: {},
    annotations: { readOnlyHint: true },
    request: () => ({ op: "daily" }),
  }),
  tool({
    mcpName: "create_daily_note",
    command: "create-daily",
    op: "daily",
    description:
      "Create today's daily note from the vault's template and return its path. Does nothing if it already exists. " +
      "Call this only when you are about to write to the note, because an empty note clutters the human's vault. " +
      "Template text starts as author unknown. Fails if the Daily notes plugin is off, or its folder or template doesn't exist. Requires Obsidian running.",
    input: {},
    request: () => ({ op: "daily", create: true }),
  }),
];

/** The tools a surface offers: a host without Obsidian serves only the limited set. */
export const toolsFor = (mode: Mode) => (mode === "full" ? TOOLS : TOOLS.filter((t) => !FULL_ONLY_OPS.has(t.op)));

/** Whether a tool records an author, and so needs an agent identity. */
export const recordsAuthor = (t: ToolDef) => "why" in t.input;

/** One tool call, the path shared by the MCP server and the CLI. `noAgent` is the surface's advice when no identity is known. */
export async function runTool(t: ToolDef, args: unknown, ctx: { ops: OpsTransport; agent: AgentId | null; noAgent: string }): Promise<Rendered> {
  if (recordsAuthor(t) && !ctx.agent) return render({ ok: false, code: "invalid", message: ctx.noAgent });
  return render(await ctx.ops(t.request(args as never, ctx.agent!)));
}
