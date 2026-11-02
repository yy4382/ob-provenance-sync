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
  /** One character this edit inserted, by id, which tells a reader whether another device's snapshot has this work. A removal alone has none. */
  wrote?: [client: number, clock: number];
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

/**
 * Where one device's work on a note stops. Each device edits its own branch, so
 * another device's `pre` can lack this device's edits: only the device itself
 * can say what its branch held.
 */
export interface SealEntry {
  t: "seal";
  id: FileId;
  at: number;
  device: string;
  /** Y.encodeSnapshot of the note just before a remote change merged in, or just after a host's own write. */
  post: Uint8Array;
}

/** Immutable once appended. */
export type Entry = EditEntry | TreeEntry | SealEntry;

/** The longest a note's text between two restorable points can run while it's being edited. */
export const PRE_EVERY = 5 * 60_000;
/** Changes from elsewhere this close together are people typing live, not a branch merging in, so they don't each end a burst. */
export const SEAL_GAP = 60_000;
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
    wrote: z.tuple([z.number(), z.number()]).optional(),
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
  z.object({
    t: z.literal("seal"),
    id: z.string(),
    at: z.number(),
    device: z.string(),
    post: z.instanceof(Uint8Array),
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
  /** A note's seal, until a `pre` takes over from it. */
  sealed: Map<FileId, SealEntry>;
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
  /** Notes edited here since their last seal. Outlives a week: offline work can cross one. */
  private readonly dirty = new Set<FileId>();

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

  /** Replays this device's entries from before the open week, which `weekEntries` can't reach. */
  carry(entries: Entry[]): void {
    for (const e of entries) this.track(e);
  }

  private track(e: Entry): void {
    if (e.device !== this.device) return;
    if (e.t === "edit") this.dirty.add(e.id);
    if (e.t === "seal") this.dirty.delete(e.id);
  }

  private remembered(at: number): WeekMemory {
    const week = weekOf(at);
    if (this.memory?.week === week) return this.memory;
    const memory: WeekMemory = { week, lastPre: new Map(), sealed: new Map(), minute: minuteOf(at), seen: new Set() };
    for (const e of parseEntries(this.weekEntries(at).toArray())) {
      this.track(e);
      if (e.device !== this.device) continue;
      if (e.t === "seal") {
        memory.sealed.set(e.id, e);
        memory.seen.clear();
      }
      if (e.t !== "edit") continue;
      if (e.pre) {
        memory.lastPre.set(e.id, Math.max(memory.lastPre.get(e.id) ?? 0, e.at));
        memory.sealed.delete(e.id);
      }
      if (minuteOf(e.at) === memory.minute) memory.seen.add(editKey(e.id, e.by, e.removes));
    }
    return (this.memory = memory);
  }

  /** Whether something other than this device changed the note since its seal. If not, its next edit just carries on from there. */
  private movedSinceSeal(id: FileId, doc: Y.Doc, memory: WeekMemory): boolean {
    const sealed = memory.sealed.get(id);
    return !!sealed && !this.dirty.has(id) && !Y.equalSnapshots(Y.decodeSnapshot(sealed.post), Y.snapshot(doc));
  }

  private preDue(id: FileId, doc: Y.Doc): boolean {
    const at = this.now();
    const memory = this.remembered(at);
    return at - (memory.lastPre.get(id) ?? -Infinity) >= PRE_EVERY || this.movedSinceSeal(id, doc, memory);
  }

  private seal(id: FileId, post: Y.Snapshot): void {
    const at = this.now();
    const memory = this.remembered(at);
    const entry: SealEntry = { t: "seal", id, at, device: this.device, post: Y.encodeSnapshot(post) };
    memory.sealed.set(id, entry);
    // The next edit has to be on record, or the burst would seem to end here.
    memory.seen.clear();
    this.dirty.delete(id);
    this.append(entry);
  }

  /** Ends a write for a host that holds a note only while writing it, and so never hears the change that would end its burst. */
  sealWrite(id: FileId, doc: Y.Doc): void {
    const at = this.now();
    const last = this.remembered(at).sealed.get(id);
    if (this.dirty.has(id) && (!last || at - last.at >= SEAL_GAP)) this.seal(id, Y.snapshot(doc));
  }

  private append(entry: Entry): void {
    const entries = this.weekEntries(entry.at);
    if (entries.length === 0) this.opening(weekOf(entry.at));
    entries.push([entry]);
  }

  private recordEdit(id: FileId, by: AuthorId, removes: boolean, pre: Y.Snapshot | null, inserted: Y.Item | null): void {
    const at = this.now();
    const memory = this.remembered(at);
    if (minuteOf(at) !== memory.minute) {
      memory.minute = minuteOf(at);
      memory.seen.clear();
    }
    this.dirty.add(id);
    const key = editKey(id, by, removes);
    if (!pre && memory.seen.has(key)) return;
    memory.seen.add(key);
    if (pre) {
      memory.lastPre.set(id, at);
      memory.sealed.delete(id);
    }
    this.append({ t: "edit", id, at, device: this.device, by, removes, ...(pre ? { pre: Y.encodeSnapshot(pre) } : {}), ...(inserted ? { wrote: [inserted.id.client, inserted.id.clock] } : {}) });
  }

  /**
   * Watches a note until the returned function is called. `hears` says whether
   * a change that isn't ours can be another device's yet: a device's own stored
   * text loads the same way, and must not read as a merge.
   */
  watchNote(id: FileId, doc: Y.Doc, hears: () => boolean = () => true): () => void {
    const ytext = doc.getText(TEXT_KEY);
    let stash: Y.Snapshot | null = null;
    let heard = -Infinity;
    const arriving = (tr: Y.Transaction) => !this.paused && !this.ours(tr) && hears();
    const sealDue = () => {
      const at = this.now();
      if (at - heard < SEAL_GAP) return false;
      this.remembered(at);
      return this.dirty.has(id);
    };
    const before = (tr: Y.Transaction) => {
      if (!stash && (this.live(tr) ? this.preDue(id, doc) : arriving(tr) && sealDue())) stash = Y.snapshot(doc);
    };
    // A transaction that leaves the text alone mustn't pass its snapshot to a later edit, with remote changes in between.
    const after = () => {
      stash = null;
    };
    const observer = (e: Y.YTextEvent, tr: Y.Transaction) => {
      const live = this.live(tr);
      if (!live && !arriving(tr)) return;
      if (!live) heard = this.now();
      if (!live && !stash) return;
      const { inserted, removes } = textChange(e, ytext);
      if (!inserted && !removes) return;
      if (!live) return this.seal(id, stash!);
      const by = (tr.meta.get(ACTOR) as AuthorId | undefined) ?? (inserted && authorAt(inserted)) ?? "unknown";
      this.recordEdit(id, by, removes, stash, inserted);
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
