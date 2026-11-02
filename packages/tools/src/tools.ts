import { FULL_ONLY_OPS, noteSchema, type AgentId, type OpName, type OpRequest, type OpResponse } from "@provenance/core";
import { z } from "zod";
import type { Mode } from "./instructions";
import { render, type Rendered } from "./render";
import { parseTime } from "./time";

export type OpsTransport = (req: OpRequest) => Promise<OpResponse>;

/** What a full diff may add to one MCP answer, where an agent's context is the scarce thing. */
export const MCP_DIFF_CHARS = 30_000;

const why = z
  .enum(["agent", "human-via-agent"])
  .describe(
    "agent: anything you wrote, reworded, summarized, translated or corrected. " +
      "human-via-agent: only the human's exact words, including words you move unchanged.",
  );
const note = noteSchema.optional().describe("Optional reason for this change, shown to the human on hover. One line, at most 200 characters. Add one when the reason isn't obvious.");
const path = z.string().describe("Exact, case-sensitive vault path including .md, with no leading slash, e.g. notes/today.md");
const pastPath = z.string().describe("A note's vault path including .md: its current path, an old one, or the path of a deleted note.");
const time = z
  .string()
  .refine((raw) => parseTime(raw, 0) !== null, "must be 30m, 2h, 1d, 1w or an ISO 8601 time like 2026-11-02T14:05+08:00")
  .describe("A time ago like 30m, 2h, 1d or 1w, or an ISO 8601 time like 2026-11-02T14:05+08:00. A date alone means local midnight.");
const count = z
  .string()
  .regex(/^\d+$/, "must be a whole number")
  .transform(Number);

const version = z.object({
  at: z.string().describe("When it ended, to the minute. Pass this as at to read the note as this version left it."),
  authors: z.array(z.string()),
  path: z.string().describe("The note's path at that time."),
  status: z.enum(["created", "modified", "renamed", "deleted"]),
  from: z.string().optional().describe("The path before a rename."),
  added: z.number().nullable().describe("Lines added. Null if this can't be worked out here yet."),
  removed: z.number().nullable().describe("Lines removed. Null if this can't be worked out here yet."),
  preview: z.string(),
  diff: z.string().optional().describe("Unified hunks, when asked for."),
  truncated: z.boolean().optional().describe("Part or all of this version's diff was cut."),
});

const historyOutput = z.object({
  versions: z.array(version),
  next_offset: z.number().optional().describe("Pass this as offset to continue. Absent when there's nothing more."),
  incomplete: z.enum(["server", "time"]).optional().describe("Older versions may be missing: server means the sync server can't be reached, time means the search hit its limit."),
});

type WriteArgs = { why: z.infer<typeof why>; note?: string | undefined };
const by = (a: WriteArgs, agent: AgentId) => ({ agent, why: a.why, ...(a.note ? { note: a.note } : {}) });

/** One vault operation as an agent sees it. Field names in `input` are also the CLI's flags. */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  mcpName: string;
  command: string;
  op: OpName;
  description: string;
  input: S;
  /** Shown by `ob-provenance <command> --help`. A test in apps/cli runs each one through the parser. */
  examples: string[];
  title?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  /** Declares structured output: MCP's outputSchema and the CLI's --json. */
  output?: z.ZodObject;
  /** Where the CLI's flags differ from `input`: flags arrive as strings, and a shell wants short names. */
  cli?: { input: z.ZodRawShape; toInput(flags: never): z.output<z.ZodObject<S>> };
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
    examples: ["ob-provenance --vault Notes list --prefix Projects/"],
    input: { prefix: z.string().optional().describe("Only list paths starting with this string. End it with / to match a folder.") },
    annotations: { readOnlyHint: true },
    request: ({ prefix }) => ({ op: "list", ...(prefix ? { prefix } : {}) }),
  }),
  tool({
    mcpName: "read_file",
    command: "read",
    op: "read",
    description:
      'Read a markdown file. With provenance on, text is split at sentence ends and line breaks, and each piece is printed as "[kind authors] text". ' +
      "Kinds: human (typed by a human), via-agent (the human's words inserted by an agent), agent (an agent's own words), unknown (no recorded author), " +
      "mixed (agent words combined with human or dictated words). Authors are listed in text order. " +
      'An author of "unknown" means part of the piece has no recorded author. Example: "[mixed human:alice,agent:claude-code] Half half." ' +
      "This view shows no notes or times, and drops indentation and blank lines, so copy old_string from a plain read. " +
      "Pass at to read the note as it was then, including a deleted note or an old path. A version's time from the note's history gives the text that version left. " +
      "The text is exact if nobody was editing at that time, otherwise up to 5 minutes early. Past text can be read but not restored.",
    examples: ["ob-provenance --vault Notes read --path notes/today.md", "ob-provenance --vault Notes read --path notes/today.md --provenance", "ob-provenance --vault Notes read --path notes/today.md --at 2h", "ob-provenance --vault Notes read --path notes/gone.md --at 2026-11-02T14:05+08:00"],
    input: { path: pastPath, provenance: z.boolean().optional().describe("Show who wrote each piece of text."), at: time.optional() },
    annotations: { readOnlyHint: true },
    request: ({ path, provenance, at }) => ({ op: "read", path, provenance: provenance ?? false, ...(at ? { at: parseTime(at, Date.now())! } : {}) }),
  }),
  tool({
    mcpName: "get_file_history",
    command: "history",
    op: "history",
    title: "Note history",
    description:
      "List a note's past versions, newest first: when, its path then, who changed it, lines added and removed, and a preview of what changed. " +
      "A version is a stretch of editing, so a new one starts about every 5 minutes while a note is being edited. " +
      "Each device's edits are versions of their own, so edits made offline keep their real times and authors, and two devices' versions can overlap. " +
      "History starts when this feature first ran on the vault, so nothing before that appears, and the sync server keeps it for a year unless the vault's owner set another limit. " +
      "A note keeps its history through renames, and an old path or a deleted note's path still works. " +
      "Renames and deletions have no recorded author, so they show as unknown. " +
      "Past versions can be viewed but not restored. To see a whole version, read the note with at set to that version's time.",
    examples: ["ob-provenance --vault Notes history --path notes/today.md", "ob-provenance --vault Notes history --path notes/today.md --limit 5 --offset 5 --diff", "ob-provenance --vault Notes history --path notes/today.md --json"],
    input: {
      path: pastPath,
      limit: z.number().int().min(1).max(100).optional().describe("How many versions to return. Defaults to 20, at most 100."),
      offset: z.number().int().min(0).optional().describe("How many of the newest versions to skip. A cut answer says what to pass."),
      full_diff: z.boolean().optional().describe("Replace each preview with unified diff hunks, up to 30,000 characters in one answer."),
    },
    cli: {
      input: {
        path: pastPath,
        limit: count.optional().describe("How many versions to return. Defaults to 20."),
        offset: count.optional().describe("How many of the newest versions to skip. A cut answer says what to pass."),
        diff: z.boolean().optional().describe("Replace each preview with unified diff hunks."),
      },
      toInput: ({ path, limit, offset, diff }: { path: string; limit?: number; offset?: number; diff?: boolean }) => ({ path, limit, offset, full_diff: diff }),
    },
    output: historyOutput,
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: ({ path, limit, offset, full_diff }) => ({ op: "history", path, ...(limit ? { limit } : {}), ...(offset ? { offset } : {}), ...(full_diff ? { fullDiff: true } : {}) }),
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
    examples: ['ob-provenance --vault Notes edit --path notes/plan.md --old_string "ship in May" --new_string "ship in June" --why agent --agent claude-code', 'ob-provenance --vault Notes edit --path notes/plan.md --old_string "TODO" --stdin new_string --why agent --agent claude-code < section.md'],
    input: {
      path,
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional().describe("Replace every match instead of requiring exactly one."),
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
    examples: ['ob-provenance --vault Notes append --path notes/today.md --text "- Called the dentist." --why human-via-agent --agent claude-code', "ob-provenance --vault Notes append --path notes/today.md --stdin text --why agent --agent claude-code < summary.md", "ob-provenance --vault Notes append --path notes/today.md --text $'\\n- A new line.' --why agent --agent claude-code"],
    input: { path, text: z.string(), why, note },
    request: (a, agent) => ({ op: "append", path: a.path, text: a.text, by: by(a, agent) }),
  }),
  tool({
    mcpName: "create_file",
    command: "create",
    op: "create",
    description: "Create a new markdown file and any missing folders. Fails if the path already exists in any letter case, holds a colon, or has a name starting with a dot, because the note could never reach the vault.",
    examples: ["ob-provenance --vault Notes create --path notes/idea.md --stdin content --why agent --agent claude-code < draft.md"],
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
    examples: ["ob-provenance --vault Notes rename --from notes/idea.md --to archive/idea.md"],
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
    examples: ["ob-provenance --vault Notes delete --path notes/idea.md"],
    input: { path },
    annotations: { destructiveHint: true },
    request: ({ path }) => ({ op: "delete", path }),
  }),
  tool({
    mcpName: "get_links",
    command: "links",
    op: "links",
    description: "List the existing notes and attachments this note links to. Links to missing notes are left out. Requires Obsidian running.",
    examples: ["ob-provenance --vault Notes links --path notes/today.md"],
    input: { path },
    annotations: { readOnlyHint: true },
    request: ({ path }) => ({ op: "links", path }),
  }),
  tool({
    mcpName: "get_backlinks",
    command: "backlinks",
    op: "backlinks",
    description: "List notes that link to this note. Requires Obsidian running.",
    examples: ["ob-provenance --vault Notes backlinks --path notes/today.md"],
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
    examples: ['ob-provenance --vault Notes search --query "quarterly plan"'],
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
    examples: ["ob-provenance --vault Notes daily"],
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
    examples: ["ob-provenance --vault Notes create-daily"],
    input: {},
    request: () => ({ op: "daily", create: true }),
  }),
];

/** The tools a surface offers: a host without Obsidian serves only the limited set. */
export const toolsFor = (mode: Mode) => (mode === "full" ? TOOLS : TOOLS.filter((t) => !FULL_ONLY_OPS.has(t.op)));

/** Whether a tool records an author, and so needs an agent identity. */
export const recordsAuthor = (t: ToolDef) => "why" in t.input;

/** One tool call, the path shared by the MCP server and the CLI. `noAgent` is the surface's advice when no identity is known. */
export async function runTool(t: ToolDef, args: unknown, ctx: { ops: OpsTransport; agent: AgentId | null; noAgent: string; diffChars?: number }): Promise<Rendered> {
  if (recordsAuthor(t) && !ctx.agent) return render({ ok: false, code: "invalid", message: ctx.noAgent });
  const req = t.request(args as never, ctx.agent!);
  return render(await ctx.ops(req), { diffChars: ctx.diffChars, req });
}
