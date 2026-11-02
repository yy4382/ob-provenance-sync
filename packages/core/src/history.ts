import { structuredPatch, type StructuredPatchHunk as Hunk } from "diff";
import diff from "fast-diff";
import * as Y from "yjs";
import { PRE_EVERY, weekOf, type EditEntry, type Entry, type TreeEntry } from "./journal";
import { OpError, type VaultDocs } from "./ops";
import { minuteOf, type AuthorId } from "./provenance";
import { docAt, TEXT_KEY, textAt, type FileId } from "./vault";

/** One recorded burst of one note on one device: from a `pre` to that device's next `pre` or seal. */
export interface NoteVersion {
  /** Its latest entry, to the minute. */
  at: number;
  /** Who made its entries. A tree change counts as unknown. */
  authors: AuthorId[];
  /** The note's path at that time. */
  path: string;
  status: "created" | "modified" | "renamed" | "deleted";
  from?: string;
  /** Lines, null if a side can't be restored here or its device hasn't said where its work ended. */
  added: number | null;
  removed: number | null;
  preview: string;
  diff?: string;
}

/** What cut an answer short: a server that can't be reached, or the time limit. */
export type Incomplete = "server" | "time";

export interface HistoryResult {
  versions: NoteVersion[];
  next_offset?: number;
  incomplete?: Incomplete;
}

export const HISTORY_LIMIT = 20;
/** Scanning stops here, and at most one batch of weeks and one open note can follow, which leaves room inside the CLI's 15 seconds. */
const SCAN_MS = 7000;
const ANSWER_MS = 12_000;
/** A round trip per past week adds up, and a scan usually stops after the first few. */
const WEEKS_AT_ONCE = 8;
/** A rewrite beyond this many changed lines counts as replacing the whole note, because diffing it would stall the host. */
const MAX_EDIT = 2000;
const PREVIEW_POINTS = 100;
/** Removed text follows added text in a preview only with room to say something. */
const PREVIEW_MIN_REMOVED = 16;
/** A preview shows 100 code points, so a huge changed block needn't be compared whole. */
const CROP_SOURCE = 2000;
const MINUTE = 60_000;

/** One device's stretch of work on its own branch of a note. Bursts from different devices can overlap in time. */
interface Burst {
  device: string;
  entries: Array<EditEntry | TreeEntry>;
  /** The text it starts from, if it starts with a snapshot. */
  pre: Uint8Array | null;
  /** The device's next `pre` or seal, which holds this burst's work and nothing merged after it. */
  end: { snapshot: Uint8Array; at: number } | null;
}

/** Ordered by their latest entries, oldest first. `entries` is one note's, sorted by `at`. */
function burstsOf(entries: Entry[]): Burst[] {
  const bursts: Burst[] = [];
  const latest = new Map<string, Burst>();
  const open = new Map<string, Burst[]>();
  const ending = (device: string, end: Burst["end"]) => {
    for (const burst of open.get(device) ?? []) burst.end = end;
    open.delete(device);
  };
  const opening = (burst: Burst) => open.set(burst.device, [...(open.get(burst.device) ?? []), burst]);

  for (const entry of entries) {
    const { device } = entry;
    if (entry.t === "seal") {
      ending(device, { snapshot: entry.post, at: entry.at });
      continue;
    }
    const last = latest.get(device);
    const pre = entry.t === "edit" ? (entry.pre ?? null) : null;
    if (pre) ending(device, { snapshot: pre, at: entry.at });
    // A rename long after the last edit isn't part of that edit, whose time and counts it would otherwise take over.
    const apart = entry.t === "tree" && !!last && entry.at - last.entries.at(-1)!.at >= PRE_EVERY;
    if (!last || pre || apart) {
      const burst: Burst = { device, entries: [entry], pre, end: null };
      bursts.push(burst);
      latest.set(device, burst);
      opening(burst);
      continue;
    }
    last.entries.push(entry);
    // A host seals every write, and writing on from the sealed text is the same burst.
    if (entry.t === "edit" && last.end) {
      last.end = null;
      opening(last);
    }
  }
  return bursts.sort((a, b) => a.entries.at(-1)!.at - b.entries.at(-1)!.at);
}

const noteEntries = (entries: Entry[], id: FileId) => entries.filter((e) => e.id === id).sort((a, b) => a.at - b.at);

/** The note the newest tree entry naming `path` belongs to. */
function namedBy(entries: Entry[], path: string): FileId | null {
  let newest: TreeEntry | null = null;
  for (const e of entries) if (e.t === "tree" && (e.to === path || e.from === path) && (!newest || e.at > newest.at)) newest = e;
  return newest?.id ?? null;
}

interface Scan {
  id: FileId | null;
  entries: Entry[];
  incomplete?: Incomplete;
}

/** Reads weeks newest first until `enough`, given the note's entries so far and the next week it would read. */
async function scan(docs: VaultDocs, path: string, deadline: number, now: () => number, enough: (mine: Entry[], next: number) => boolean): Promise<Scan> {
  const index = await docs.index();
  const weeks = index.weeks();
  const entries: Entry[] = [];
  let id = index.idOf(path) ?? null;
  let unreached = false;
  while (weeks.length) {
    if (id && enough(noteEntries(entries, id), weeks[0]!)) break;
    if (now() >= deadline) return { id, entries, incomplete: "time" };
    const reads = await Promise.all(weeks.splice(0, WEEKS_AT_ONCE).map((n) => docs.week(n)));
    for (const read of reads) {
      entries.push(...read.entries);
      unreached ||= !read.complete;
    }
    id ??= namedBy(entries, path);
  }
  return { id, entries, ...(unreached ? { incomplete: "server" as const } : {}) };
}

function notFound(path: string, incomplete: Incomplete | undefined): OpError {
  if (incomplete === "server") return new OpError("unavailable", `no such file here: ${path}. Older history needs the sync server, which can't be reached.`);
  if (incomplete === "time") return new OpError("unavailable", `no such file: ${path}, as far back as this search reached before its time limit.`);
  return new OpError("not-found", `no such file: ${path}`);
}

type Bound = { pre: Uint8Array } | "current" | "empty" | null;

/** Whether `outer` has everything `inner` has. Both come from Y.snapshot, so each client's delete ranges are sorted and merged. */
function contains(outer: Y.Snapshot, inner: Y.Snapshot): boolean {
  for (const [client, clock] of inner.sv) if ((outer.sv.get(client) ?? 0) < clock) return false;
  for (const [client, ranges] of inner.ds.clients) {
    const theirs = outer.ds.clients.get(client) ?? [];
    let at = 0;
    for (const { clock, len } of ranges) {
      while (at < theirs.length && theirs[at]!.clock + theirs[at]!.len <= clock) at++;
      const range = theirs[at];
      if (!range || range.clock > clock || range.clock + range.len < clock + len) return false;
    }
  }
  return true;
}

/**
 * Where the text stands as burst `i` ends. With no bound of its own device,
 * another device's later `pre` serves if it can hold this burst's edits, which
 * means it has this burst's start and more. If later `pre`s exist and none can,
 * they're on other branches and the current text has their edits in it, so
 * nothing here shows this burst alone until its device or a later edit says.
 */
function endOf(bursts: Burst[], i: number): Bound {
  const burst = bursts[i]!;
  if (burst.end) return { pre: burst.end.snapshot };
  const ended = burst.entries.at(-1)!.at;
  const later = bursts.slice(i + 1).flatMap((b) => (b.pre && b.entries[0]!.at >= ended ? [b.pre] : []));
  const start = burst.pre && snapshotOf(burst.pre);
  if (!start) return later[0] ? { pre: later[0] } : "current";
  const holding = later.find((pre) => {
    const snapshot = snapshotOf(pre);
    return snapshot && contains(snapshot, start) && !Y.equalSnapshots(snapshot, start);
  });
  return holding ? { pre: holding } : later.length ? null : "current";
}

/** Where the text stands as burst `i` starts. A burst of tree changes alone leaves the text as it found it. */
function startOf(bursts: Burst[], i: number): Bound {
  const { pre, entries } = bursts[i]!;
  if (pre) return { pre };
  return entries.some((e) => e.t === "edit") ? null : endOf(bursts, i);
}

/** Where the text stood at `cut`: the one bound a version's own time has to land on, and otherwise at most PRE_EVERY early. */
function boundAt(bursts: Burst[], cut: number): Bound {
  const editedBy = (b: Burst, at: number) => b.entries.some((e) => e.t === "edit" && e.at < at);
  let i = bursts.length - 1;
  while (i >= 0 && !editedBy(bursts[i]!, cut)) i--;
  if (i < 0) {
    const [first] = bursts.filter((b) => b.pre).sort((a, b) => a.entries[0]!.at - b.entries[0]!.at);
    return first ? { pre: first.pre! } : bursts.some((b) => editedBy(b, Infinity)) ? null : "current";
  }
  const burst = bursts[i]!;
  if (burst.entries.some((e) => e.t === "edit" && e.at >= cut)) return startOf(bursts, i);
  const ownTime = minuteOf(burst.entries.at(-1)!.at) + MINUTE === cut;
  const merged = !ownTime && burst.end && burst.end.at < cut ? snapshotOf(burst.end.snapshot) : null;
  if (!merged) return endOf(bursts, i);
  // A seal before this time means the branch merged, so the text since is that merge, which only the next edit or the note itself holds.
  const next = bursts.slice(i + 1).find((b) => {
    const snapshot = b.pre && snapshotOf(b.pre);
    return snapshot && contains(snapshot, merged);
  });
  return next ? { pre: next.pre! } : "current";
}

/** One version in every field but those that need the note's text. */
function shapesOf(bursts: Burst[], currentPath: string) {
  let path = currentPath;
  const shapes = [];
  for (let i = bursts.length - 1; i >= 0; i--) {
    const { entries } = bursts[i]!;
    const tree = entries.filter((e): e is TreeEntry => e.t === "tree");
    const [first, last] = [tree[0], tree.at(-1)];
    const after = last ? (last.to ?? last.from ?? path) : path;
    const status: NoteVersion["status"] =
      last?.to === null ? "deleted" : tree.some((e) => e.from === null) ? "created" : first?.from != null && first.from !== last?.to ? "renamed" : "modified";
    const known = entries.flatMap((e) => (e.t === "edit" && e.by !== "unknown" ? [e.by] : []));
    const unknown = entries.some((e) => e.t === "tree" || e.by === "unknown");
    shapes.push({
      at: minuteOf(entries.at(-1)!.at),
      authors: [...new Set(known), ...(unknown ? ["unknown" as const] : [])],
      path: after,
      status,
      ...(status === "renamed" ? { from: first!.from! } : {}),
      before: status === "created" ? ("empty" as const) : startOf(bursts, i),
      after: status === "deleted" ? ("empty" as const) : endOf(bursts, i),
    });
    path = first?.from ?? first?.to ?? path;
  }
  return shapes;
}

function snapshotOf(pre: Uint8Array): Y.Snapshot | null {
  try {
    return Y.decodeSnapshot(pre);
  } catch {
    return null;
  }
}

function textOf(bound: Bound, doc: Y.Doc): string | null {
  if (bound === null) return null;
  if (bound === "empty") return "";
  if (bound === "current") return doc.getText(TEXT_KEY).toString();
  const snapshot = snapshotOf(bound.pre);
  return snapshot && textAt(doc, snapshot);
}

const linesIn = (text: string) => (text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0);

function hunksOf(before: string, after: string): Hunk[] {
  const patch = structuredPatch("", "", before, after, undefined, undefined, { context: 3, maxEditLength: MAX_EDIT });
  if (patch) return patch.hunks;
  const signed = (sign: string, text: string) => (text ? text.replace(/\n$/, "").split("\n").map((l) => sign + l) : []);
  return [{ oldStart: 1, oldLines: linesIn(before), newStart: 1, newLines: linesIn(after), lines: [...signed("-", before), ...signed("+", after)] }];
}

function points(text: string, max: number): string {
  const all = [...text];
  return all.length <= max ? text : `${all.slice(0, max - 1).join("")}…`;
}

const oneLine = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).join(" / ");

/**
 * What changed in a block of replaced lines, so a one-word fix in a long
 * paragraph shows that word. Only the text both sides share at their ends is
 * dropped, up to a word boundary: fast-diff's inner chunks are single letters.
 */
function cropped(removed: string[], added: string[]): { removed: string[]; added: string[] } {
  if (!removed.length || !added.length) return { removed, added };
  const [old, now] = [removed.join("\n").slice(0, CROP_SOURCE), added.join("\n").slice(0, CROP_SOURCE)];
  const chunks = diff(old, now);
  let head = chunks[0]![0] === diff.EQUAL ? chunks[0]![1].length : 0;
  let tail = chunks.length > 1 && chunks.at(-1)![0] === diff.EQUAL ? chunks.at(-1)![1].length : 0;
  while (head > 0 && !/\s/.test(old[head - 1]!)) head--;
  while (tail > 0 && !/\s/.test(old[old.length - tail]!)) tail--;
  const middle = (text: string) => text.slice(head, text.length - tail);
  return { removed: [middle(old)], added: [middle(now)] };
}

function previewOf(hunks: Hunk[]): string {
  const added: string[] = [];
  const removed: string[] = [];
  let run: { removed: string[]; added: string[] } = { removed: [], added: [] };
  const flush = () => {
    const crop = cropped(run.removed, run.added);
    added.push(...crop.added);
    removed.push(...crop.removed);
    run = { removed: [], added: [] };
  };
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("-")) run.removed.push(line.slice(1));
      else if (line.startsWith("+")) run.added.push(line.slice(1));
      else if (!line.startsWith("\\")) flush();
    }
    flush();
  }
  const plus = oneLine(added.join("\n"));
  const minus = oneLine(removed.join("\n"));
  const shown = plus ? `+ ${points(plus, PREVIEW_POINTS - 2)}` : "";
  const room = PREVIEW_POINTS - [...shown].length - (shown ? 3 : 2);
  if (!minus || room < PREVIEW_MIN_REMOVED) return shown;
  return `${shown}${shown ? " " : ""}- ${points(minus, room)}`;
}

const countOf = (hunks: Hunk[], sign: string) => hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith(sign)).length, 0);

const hunkText = (hunks: Hunk[]) => hunks.map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join("\n")).join("\n");

export interface HistoryRequest {
  path: string;
  limit?: number | undefined;
  offset?: number | undefined;
  fullDiff?: boolean | undefined;
}

/** A note's versions, newest first. Identity follows the file id, so renames keep their history. */
export async function history(docs: VaultDocs, req: HistoryRequest, now: () => number = Date.now): Promise<HistoryResult> {
  const { path, limit = HISTORY_LIMIT, offset = 0, fullDiff = false } = req;
  const start = now();
  const wanted = offset + limit;
  const found = await scan(docs, path, start + SCAN_MS, now, (mine) => burstsOf(mine).length > wanted);
  if (!found.id) throw notFound(path, found.incomplete);
  const id = found.id;
  const bursts = burstsOf(noteEntries(found.entries, id));
  const shapes = shapesOf(bursts, (await docs.index()).get(id)?.path ?? path).slice(offset, wanted);

  const texts = await docs.peekText(id, (ytext) => {
    const out: Array<{ before: string | null; after: string | null }> = [];
    for (const shape of shapes) {
      if (out.length && now() >= start + ANSWER_MS) break;
      out.push({ before: textOf(shape.before, ytext.doc!), after: textOf(shape.after, ytext.doc!) });
    }
    return out;
  });

  const versions = shapes.slice(0, texts?.length ?? shapes.length).map(({ before: _before, after: _after, ...shape }, i): NoteVersion => {
    const text = texts?.[i];
    if (text?.before == null || text.after == null) return { ...shape, added: null, removed: null, preview: "" };
    const hunks = hunksOf(text.before, text.after);
    return { ...shape, added: countOf(hunks, "+"), removed: countOf(hunks, "-"), preview: previewOf(hunks), ...(fullDiff ? { diff: hunkText(hunks) } : {}) };
  });
  const cut = versions.length < shapes.length;
  const more = cut || bursts.length > wanted;
  const incomplete = found.incomplete ?? (cut ? "time" : texts ? undefined : "server");
  return { versions, ...(more ? { next_offset: offset + versions.length } : {}), ...(incomplete ? { incomplete } : {}) };
}

export interface PastText {
  /** A document of its own, so it outlives the note it was restored from. */
  doc: Y.Doc;
  incomplete?: Incomplete;
}

const utc = (ms: number) => new Date(ms).toISOString();

/**
 * The text at time `at`. Times are printed to the minute, so `at` means the end
 * of its minute, and a version's own time gives the text it left. Exact if the
 * note was quiet, at most PRE_EVERY early if it was being edited.
 */
export async function readAt(docs: VaultDocs, path: string, at: number, now: () => number = Date.now): Promise<PastText> {
  const cut = minuteOf(at) + MINUTE;
  const found = await scan(docs, path, now() + SCAN_MS, now, (_mine, next) => next < weekOf(cut));
  if (!found.id) throw notFound(path, found.incomplete);
  const id = found.id;
  const mine = noteEntries(found.entries, id);
  const tree = mine.filter((e): e is TreeEntry => e.t === "tree");
  const created = tree.find((e) => e.from === null);
  if (created && created.at >= cut) throw new OpError("not-found", `${path} didn't exist yet at that time: it was created at ${utc(created.at)}`);
  const last = tree.at(-1);
  if (!(await docs.index()).get(id) && last?.to === null && last.at < cut) throw new OpError("not-found", `${path} no longer existed at that time: it was deleted at ${utc(last.at)}`);

  const bound = boundAt(burstsOf(mine), cut);
  const snapshot = bound && bound !== "current" && bound !== "empty" ? snapshotOf(bound.pre) : null;
  const doc = bound !== "current" && !snapshot ? null : await docs.peekText(id, (ytext) => docAt(ytext.doc!, snapshot ?? Y.snapshot(ytext.doc!)));
  if (!doc) throw new OpError("unavailable", "this note's text from that time hasn't reached this device yet. It will once sync reconnects.");
  return { doc, ...(found.incomplete ? { incomplete: found.incomplete } : {}) };
}
