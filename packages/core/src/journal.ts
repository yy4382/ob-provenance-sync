import * as Y from "yjs";
import { z } from "zod";
import { minuteOf, type AuthorId } from "./provenance";
import { TEXT_KEY, type FileEntry, type FileId } from "./vault";

export interface EditEntry {
  t: "edit";
  id: FileId;
  /** The writer's clock, the same clock as `pt`. */
  at: number;
  device: string;
  /** Who acted. Only the writer can know this for a removal, which is why the entry exists. */
  by: AuthorId;
  removes: boolean;
  /** Y.encodeSnapshot of the note just before this entry's first change. */
  pre?: Uint8Array;
}

/** from null: created. to null: deleted. from === to: an attachment's bytes changed. */
export interface TreeEntry {
  t: "tree";
  id: FileId;
  at: number;
  device: string;
  from: string | null;
  to: string | null;
  binary: boolean;
}

/** Immutable once appended. */
export type Entry = EditEntry | TreeEntry;

/** The longest a note's text between two restorable points can run while it's being edited. */
export const PRE_EVERY = 5 * 60_000;
export const WEEK = 7 * 24 * 60 * 60_000;
export const DAY = 24 * 60 * 60_000;
export const HISTORY_DAYS = 365;
/** A device's journal is a cache of recent weeks, so offline edits keep their times, authors and versions. */
export const LOCAL_HISTORY_DAYS = 30;

export const weekOf = (at: number): number => Math.floor(at / WEEK);
export const entriesOf = (doc: Y.Doc): Y.Array<Entry> => doc.getArray<Entry>("entries");
/** The oldest week a host keeps. Weeks go whole, so a host keeps at least `days`. */
export const oldestWeek = (historyDays: number, now: number): number => weekOf(now - historyDays * DAY);

const entrySchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("edit"),
    id: z.string(),
    at: z.number(),
    device: z.string(),
    by: z.string(),
    removes: z.boolean(),
    pre: z.instanceof(Uint8Array).optional(),
  }),
  z.object({
    t: z.literal("tree"),
    id: z.string(),
    at: z.number(),
    device: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    binary: z.boolean(),
  }),
]);

/** Parses at the read boundary. An entry this version doesn't know is skipped, so a newer writer can't break an older reader. */
export function parseEntries(raw: unknown[]): Entry[] {
  return raw.flatMap((item) => {
    const parsed = entrySchema.safeParse(item);
    return parsed.success ? [parsed.data as Entry] : [];
  });
}

const ACTOR = Symbol("actor");

/** Names who is acting in the current transaction. Sets transaction meta only, and leaves the document's state alone. */
export function markActor(doc: Y.Doc, by: AuthorId): void {
  doc.transact((tr) => tr.meta.set(ACTOR, by));
}

/** What this device already wrote to one week, which on the server is all it has to go on between requests. */
interface WeekMemory {
  week: number;
  lastPre: Map<FileId, number>;
  minute: number;
  seen: Set<string>;
}

/** The author in force at `item`. */
function authorAt(item: Y.Item): AuthorId | undefined {
  for (let left = item.left; left; left = left.left) {
    if (!left.deleted && left.content instanceof Y.ContentFormat && left.content.key === "pa") return (left.content.value as AuthorId | null) ?? undefined;
  }
  return undefined;
}

/**
 * What a transaction did to the text itself. Format marks aren't countable, so
 * a change of author alone is no change. It walks the items because e.delta,
 * and e.changes which reads it, delete redundant format marks in a transaction
 * of their own, and that would be a write to the note.
 */
function textChange(e: Y.YTextEvent, ytext: Y.Text): { inserted: Y.Item | null; removes: boolean } {
  const anyDeletes = e.transaction.deleteSet.clients.size > 0;
  let inserted: Y.Item | null = null;
  let removes = false;
  for (let item = ytext._start; item; item = item.right) {
    if (!item.countable) continue;
    if (!item.deleted) inserted ??= e.adds(item) ? item : null;
    else if (anyDeletes && e.deletes(item) && !e.adds(item)) removes = true;
    if (inserted && (removes || !anyDeletes)) break;
  }
  return { inserted, removes };
}

const editKey = (id: FileId, by: AuthorId, removes: boolean) => `${id}\0${by}\0${removes}`;

/**
 * The record's only writer. Whoever makes a change appends the entry, because
 * only they know who did it and when, and nobody records another host's
 * change. It observes documents and never writes to them, so a note's sync
 * can't tell it's there.
 */
export class Recorder {
  /** A device's first scan is a baseline, not an event: installing doesn't report the vault as new. */
  paused = false;
  private memory: WeekMemory | null = null;

  constructor(
    private readonly device: string,
    /** The array for the week holding `at`. Synchronous: it runs inside a Yjs observer. */
    private readonly weekEntries: (at: number) => Y.Array<Entry>,
    /** Changes this host originated. */
    private readonly ours: (tr: Y.Transaction) => boolean,
    /** Called before a week's first entry, so readers can find the week. */
    private readonly opening: (week: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private live(tr: Y.Transaction): boolean {
    return !this.paused && this.ours(tr);
  }

  private remembered(at: number): WeekMemory {
    const week = weekOf(at);
    if (this.memory?.week === week) return this.memory;
    const memory: WeekMemory = { week, lastPre: new Map(), minute: minuteOf(at), seen: new Set() };
    for (const e of parseEntries(this.weekEntries(at).toArray())) {
      if (e.t !== "edit" || e.device !== this.device) continue;
      if (e.pre) memory.lastPre.set(e.id, Math.max(memory.lastPre.get(e.id) ?? 0, e.at));
      if (minuteOf(e.at) === memory.minute) memory.seen.add(editKey(e.id, e.by, e.removes));
    }
    return (this.memory = memory);
  }

  private preDue(id: FileId): boolean {
    const at = this.now();
    return at - (this.remembered(at).lastPre.get(id) ?? -Infinity) >= PRE_EVERY;
  }

  private append(entry: Entry): void {
    const entries = this.weekEntries(entry.at);
    if (entries.length === 0) this.opening(weekOf(entry.at));
    entries.push([entry]);
  }

  private recordEdit(id: FileId, by: AuthorId, removes: boolean, pre: Y.Snapshot | null): void {
    const at = this.now();
    const memory = this.remembered(at);
    if (minuteOf(at) !== memory.minute) {
      memory.minute = minuteOf(at);
      memory.seen.clear();
    }
    const key = editKey(id, by, removes);
    if (!pre && memory.seen.has(key)) return;
    memory.seen.add(key);
    if (pre) memory.lastPre.set(id, at);
    this.append({ t: "edit", id, at, device: this.device, by, removes, ...(pre ? { pre: Y.encodeSnapshot(pre) } : {}) });
  }

  /** Watches a note until the returned function is called. */
  watchNote(id: FileId, doc: Y.Doc): () => void {
    const ytext = doc.getText(TEXT_KEY);
    let stash: Y.Snapshot | null = null;
    const before = (tr: Y.Transaction) => {
      if (!stash && this.live(tr) && this.preDue(id)) stash = Y.snapshot(doc);
    };
    // A transaction that leaves the text alone mustn't pass its snapshot to a later edit, with remote changes in between.
    const after = () => {
      stash = null;
    };
    const observer = (e: Y.YTextEvent, tr: Y.Transaction) => {
      if (!this.live(tr)) return;
      const { inserted, removes } = textChange(e, ytext);
      if (!inserted && !removes) return;
      const by = (tr.meta.get(ACTOR) as AuthorId | undefined) ?? (inserted && authorAt(inserted)) ?? "unknown";
      this.recordEdit(id, by, removes, stash);
    };
    doc.on("beforeTransaction", before);
    doc.on("afterTransaction", after);
    ytext.observe(observer);
    return () => {
      doc.off("beforeTransaction", before);
      doc.off("afterTransaction", after);
      ytext.unobserve(observer);
    };
  }

  /** Watches the index. Every way a file is added, moved or dropped ends up as one of these key changes. */
  watchIndex(files: Y.Map<FileEntry>): () => void {
    const observer = (e: Y.YMapEvent<FileEntry>, tr: Y.Transaction) => {
      if (!this.live(tr)) return;
      const at = this.now();
      for (const [key, change] of e.keys) {
        const was = change.oldValue as FileEntry | undefined;
        const entry = files.get(key);
        const from = was?.path ?? null;
        const to = entry?.path ?? null;
        const binary = (entry ?? was)?.type === "binary";
        if (from === to && !binary) continue;
        this.append({ t: "tree", id: key as FileId, at, device: this.device, from, to, binary });
      }
    };
    files.observe(observer);
    return () => files.unobserve(observer);
  }
}
