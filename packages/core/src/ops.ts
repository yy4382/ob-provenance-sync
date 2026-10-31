import { z } from "zod";
import type * as Y from "yjs";
import { attribute } from "./attribution";
import { agentIdSchema, agentProvenance, noteSchema, type SegmentKind } from "./provenance";
import { EditError, insertText, replaceText } from "./text";
import { isMarkdownPath, markNote, newFileId, type FileId, type VaultIndex } from "./vault";

/** Only Obsidian's own normalized form, so one file can never be reached under two spellings. */
const pathSchema = z
  .string()
  .min(1)
  .refine(
    (p) => p === p.trim() && !p.includes("\\") && p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."),
    "must be a normalized vault-relative path like folder/note.md",
  );
const markdownPath = pathSchema.refine(isMarkdownPath, "must be a .md file");

const bySchema = z.object({
  agent: agentIdSchema,
  why: z.enum(["agent", "human-via-agent"]),
  note: noteSchema.optional(),
});

/**
 * The one protocol every vault host speaks: the plugin's localhost bridge, the
 * server's HTTP API, and the in-process remote MCP all accept these requests.
 */
export const opRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), prefix: z.string().optional() }),
  z.object({ op: z.literal("read"), path: markdownPath, provenance: z.boolean().optional() }),
  z.object({
    op: z.literal("edit"),
    path: markdownPath,
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
    by: bySchema,
  }),
  z.object({ op: z.literal("append"), path: markdownPath, text: z.string().min(1), by: bySchema }),
  z.object({ op: z.literal("create"), path: markdownPath, content: z.string(), by: bySchema }),
  z.object({ op: z.literal("rename"), from: markdownPath, to: markdownPath }),
  z.object({ op: z.literal("delete"), path: markdownPath }),
  z.object({ op: z.literal("links"), path: markdownPath }),
  z.object({ op: z.literal("backlinks"), path: markdownPath }),
  z.object({ op: z.literal("search"), query: z.string().min(1) }),
  z.object({ op: z.literal("daily") }),
]);
export type OpRequest = z.infer<typeof opRequestSchema>;
export type OpName = OpRequest["op"];

/** Ops that need a running Obsidian (metadata cache, file explorer semantics). */
export const FULL_ONLY_OPS = new Set<OpName>(["rename", "delete", "links", "backlinks", "search", "daily"]);

export interface AttributedSentence {
  text: string;
  kind: SegmentKind;
  authors: string[];
}

export type OpResult =
  | { op: "list"; files: string[] }
  | { op: "read"; content: string; sentences?: AttributedSentence[] }
  | { op: "edit"; replaced: number }
  | { op: "append" | "create" | "delete" }
  | { op: "rename"; linksPending?: boolean }
  | { op: "links" | "backlinks" | "search"; paths: string[] }
  | { op: "daily"; path: string };

export type OpResponse = { ok: true; result: OpResult } | { ok: false; code: OpErrorCode; message: string };
export type OpErrorCode = "invalid" | "not-found" | "ambiguous" | "exists" | "unsupported" | "unavailable";

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Access to a vault's documents, implemented by whoever holds them. */
export interface VaultDocs {
  readonly device: string;
  index(): Promise<VaultIndex>;
  updateIndex(fn: (index: VaultIndex) => void): Promise<void>;
  readText(id: FileId): Promise<Y.Text>;
  updateText<T>(id: FileId, fn: (ytext: Y.Text) => T): Promise<T>;
}

async function requireId(docs: VaultDocs, path: string): Promise<FileId> {
  const id = (await docs.index()).idOf(path);
  if (!id) throw new OpError("not-found", `no such file: ${path}`);
  return id;
}

const byOf = (req: Extract<OpRequest, { by: unknown }>, docs: VaultDocs) =>
  agentProvenance(req.by.agent, req.by.why, req.by.note ?? null, docs.device);

export async function executeOp(docs: VaultDocs, req: OpRequest): Promise<OpResult> {
  switch (req.op) {
    case "list": {
      const files = (await docs.index())
        .entries()
        .map(([, e]) => e.path)
        .filter((p) => !req.prefix || p.startsWith(req.prefix))
        .sort();
      return { op: "list", files };
    }
    case "read": {
      const ytext = await docs.readText(await requireId(docs, req.path));
      const content = ytext.toString();
      if (!req.provenance) return { op: "read", content };
      const sentences = attribute(ytext).map((s) => ({
        text: content.slice(s.from, s.to),
        kind: s.kind,
        authors: [...new Set(s.contributors.map((c) => c.author))],
      }));
      return { op: "read", content, sentences };
    }
    case "edit": {
      const by = byOf(req, docs);
      const id = await requireId(docs, req.path);
      try {
        const replaced = await docs.updateText(id, (t) => replaceText(t, req.oldString, req.newString, by, req.replaceAll));
        return { op: "edit", replaced };
      } catch (e) {
        if (e instanceof EditError) throw new OpError(e.code, e.message);
        throw e;
      }
    }
    case "append": {
      const by = byOf(req, docs);
      await docs.updateText(await requireId(docs, req.path), (t) => insertText(t, t.length, req.text, by));
      return { op: "append" };
    }
    case "create": {
      if ((await docs.index()).idOf(req.path)) throw new OpError("exists", `file already exists: ${req.path}`);
      const by = byOf(req, docs);
      const id = newFileId();
      await docs.updateText(id, (t) => {
        markNote(t.doc!);
        insertText(t, 0, req.content, by);
      });
      await docs.updateIndex((index) => index.set(id, { type: "markdown", path: req.path }));
      return { op: "create" };
    }
    case "rename": {
      const id = await requireId(docs, req.from);
      if ((await docs.index()).idOf(req.to)) throw new OpError("exists", `file already exists: ${req.to}`);
      await docs.updateIndex((index) => index.rename(id, req.to));
      return { op: "rename" };
    }
    case "delete": {
      const id = await requireId(docs, req.path);
      await docs.updateIndex((index) => index.delete(id));
      return { op: "delete" };
    }
    case "links":
    case "backlinks":
    case "search":
    case "daily":
      throw new OpError("unsupported", `${req.op} needs Obsidian running (full mode)`);
  }
}

/** Parses an untrusted request and runs it, turning every failure into a response. */
export async function handleOpRequest(
  docs: VaultDocs,
  raw: unknown,
  run: (req: OpRequest) => Promise<OpResult> = (req) => executeOp(docs, req),
): Promise<OpResponse> {
  const parsed = opRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "invalid", message: z.prettifyError(parsed.error) };
  try {
    return { ok: true, result: await run(parsed.data) };
  } catch (e) {
    if (e instanceof OpError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "unavailable", message: errorMessage(e) };
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
