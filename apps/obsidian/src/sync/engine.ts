import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
  adoptText,
  agentProvenance,
  conflictPath,
  DAY,
  difference,
  entriesOf,
  errorMessage,
  fileDocName,
  hasState,
  humanProvenance,
  indexDocName,
  isMarkdownPath,
  journalDocName,
  journalWeekOf,
  LOCAL_HISTORY_DAYS,
  markActor,
  markNote,
  newFileId,
  oldestWeek,
  OpError,
  pairRenames,
  parseEntries,
  Recorder,
  repairedConflictPath,
  rewriteRange,
  setText,
  TEXT_KEY,
  textAt,
  unknownProvenance,
  VaultIndex,
  weekOf,
  type Entry,
  type FileEntry,
  type AgentId,
  type AgentWhy,
  type FileId,
  type HumanId,
  type Provenance,
  type VaultDocs,
} from "@provenance/core";
import * as Y from "yjs";
import { proto } from "../proto";

/** The vault's files as the engine sees them; the host's file API in the plugin, a Map in tests. */
export interface Disk {
  /** Whether a path belongs to the synced vault (the config folder doesn't). */
  accepts(path: string): boolean;
  list(): Promise<Array<{ path: string; binary: boolean }>>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** Writes `text` only if the file still holds `expected`, as one step. Resolves to whether it wrote. */
  writeIfUnchanged(path: string, expected: string, text: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer | null>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
}

export interface Blobs {
  put(hash: string, data: ArrayBuffer): Promise<void>;
  get(hash: string): Promise<ArrayBuffer>;
}

/** Local storage for one document, plus small per-document values. */
export interface Persistence {
  whenSynced: Promise<unknown>;
  destroy(): unknown;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
}

export interface EngineOptions {
  vault: string;
  author: HumanId;
  device: string;
  disk: Disk;
  /** Absent when no server is configured: provenance still works, it just doesn't leave this device. */
  server?: { url: string; token: string; blobs: Blobs; WebSocketPolyfill?: unknown };
  persist?: (name: string, doc: Y.Doc) => Persistence;
  /** The documents behind `persist`. `names` is null where the host can't list them. */
  stored?: { names(): Promise<string[] | null>; drop(name: string): Promise<void> };
  /** Days of history this device keeps offline, read as it's needed. It never limits what a read returns. Defaults to LOCAL_HISTORY_DAYS. */
  localHistoryDays?: () => number;
  onStatus?: (status: SyncStatus) => void;
  onEvent?: (event: SyncEvent) => void;
}

export type SyncStatus = "offline" | "connecting" | "connected" | "local-only";

/** Something the engine did or ran into that the user may want to know about. */
export interface SyncEvent {
  /** "debug" is one file's step, for retracing what happened to it. */
  level: "debug" | "info" | "warn" | "error";
  message: string;
  path?: string;
}

/** Transaction origin for changes we read off disk, so they are not written straight back. */
export const FROM_DISK = Symbol("from-disk");

/** How long a start or scan waits for a document still loading before going on without it. */
const OPEN_WAIT = 3000;
/** Local writes remembered per path, oldest dropped first. One plugin action's burst of writes fits. */
const LOCAL_WRITES_KEPT = 16;
/** How long an agent's call waits for a note's text to arrive: less than ob-provenance's own limit, so it hears why. */
const AGENT_OPEN_WAIT = 10_000;

export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BASE_KEY = "disk-base";
const UNSENT_WEEKS_KEY = "unsent-weeks";
const SAVED_STATES = 64;

const MIRROR_KEY = "on-disk";

/** A state of a note's CRDT and its text. */
export type TextState = { snapshot: Y.Snapshot; text: string };

/**
 * PROTOTYPE. What a pane holds while it isn't bound: a text it was made from, the CRDT
 * state with that text if the pane knows it, and the pane's own edits since, as
 * non-overlapping ranges of that text in ascending order.
 */
export type PaneLog = { text: string; state: TextState | null; edits: Array<{ from: number; to: number; text: string }> };

/** Whether state `a` holds everything state `b` does: each of its items and each of its deletions. */
function contains(a: Y.Snapshot, b: Y.Snapshot): boolean {
  for (const [client, clock] of b.sv) if ((a.sv.get(client) ?? 0) < clock) return false;
  for (const [client, ranges] of b.ds.clients) {
    for (const { clock, len } of ranges) {
      for (let c = clock; c < clock + len; c++) if (!Y.isDeleted(a.ds, Y.createID(client, c))) return false;
    }
  }
  return true;
}

/**
 * One markdown file's CRDT replica.
 *
 * `base` is the CRDT state the file on disk last matched, persisted next to
 * the document. A disk change is applied as a three-way merge: replay
 * diff(base, disk) on a fork taken at the base and merge the fork back, so
 * remote changes that haven't reached the disk yet are kept rather than
 * reverted. Disk writes are debounced and skipped while an editor is bound,
 * because then the editor owns saving. When it saves, `trackWrite`
 * learns the exact text it writes and finds in `editorStates` the state the
 * editor showed with that text; once the save lands, that state is the base.
 * Telling saves apart by comparing the text read back later is not enough:
 * the read may also hold another program's edit, or an outside revert to an
 * older editor text.
 */
export class MarkdownFile {
  readonly doc = new Y.Doc({ gc: false });
  readonly ytext = this.doc.getText(TEXT_KEY);
  readonly ready: Promise<void>;
  private base: { snapshot: Y.Snapshot; text: string } | null = null;
  private readonly editorStates: Array<{ snapshot: Y.Snapshot; text: string }> = [];
  /**
   * What an editor showed when it stopped syncing with the note still open, until it binds
   * again. Its saves meanwhile, and its text then, are edits of this state.
   */
  private reopening: TextState | null = null;
  /** The text writeNow last replaced on disk. */
  private replaced: string | null = null;
  /** PROTOTYPE. States the file on disk held, newest last, so a pane's loaded text can be placed. */
  private readonly diskStates: TextState[] = [];
  /** Tracked writes in flight, and a count bumped as each starts and lands, so a read that overlapped one reads again. */
  private readonly writes = new Set<Promise<unknown>>();
  private writeEvents = 0;
  private editors = 0;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private provider: HocuspocusProvider | null = null;
  private persistence: Persistence | null = null;
  private destroyed = false;
  private knownLocally = false;
  private readonly stopRecording: () => void;
  /** Opened, and holding the server's content if this device had none. */
  loaded = false;

  constructor(
    readonly id: FileId,
    private readonly engine: SyncEngine,
    /** Created on this device, so there is nothing to fetch before it is usable. */
    private readonly createdHere: boolean,
  ) {
    this.ytext.observe((_e, tr) => {
      if (this.editors > 0) this.recordEditorState();
      if (tr.origin !== FROM_DISK) this.scheduleWrite();
    });
    this.stopRecording = engine.recorder.watchNote(id, this.doc, () => this.provider !== null);
    this.ready = this.open();
  }

  get path(): string | undefined {
    return this.engine.pathOf(this.id);
  }

  private async open(): Promise<void> {
    const { opts } = this.engine;
    const name = fileDocName(opts.vault, this.id);
    this.persistence = opts.persist?.(name, this.doc) ?? null;
    await this.persistence?.whenSynced;
    const saved = await this.persistence?.get(BASE_KEY);
    if (saved instanceof Uint8Array && this.base === null) {
      // The base and the updates are separate IndexedDB writes, so after a
      // crash the base may name updates that were never stored.
      const snapshot = Y.decodeSnapshot(saved);
      const text = textAt(this.doc, snapshot);
      if (text !== null) this.base = { snapshot, text };
    }
    this.knownLocally = Y.encodeStateVector(this.doc).length > 1;
    if (this.destroyed) return;
    this.provider = this.engine.connect(name, this.doc);
    if (!this.knownLocally && !this.createdHere && this.provider) await synced(this.provider);
    this.loaded = true;
  }

  /** The CRDT's state now, as an editor showing it could pass back to `bindEditor`. */
  textState(): TextState {
    return { snapshot: Y.snapshot(this.doc), text: this.ytext.toJSON() };
  }

  /** The text this device last had on disk for the file. */
  get diskText(): string {
    return this.base?.text ?? this.ytext.toJSON();
  }

  private setBase(snapshot: Y.Snapshot, text: string) {
    if (this.destroyed) return;
    this.base = { snapshot, text };
    this.diskStates.push(this.base);
    if (this.diskStates.length > 16) this.diskStates.shift();
    void this.persistence?.set(BASE_KEY, Y.encodeSnapshot(snapshot));
  }

  /**
   * Brings the file on disk and the CRDT together when the engine first
   * places it. A fresh device (no local history, content fetched from the
   * server) keeps a differing local file as a conflict copy instead of merging,
   * unless it is blank.
   */
  async reconcileDisk(vacant = false, placement = this.engine.placementOf(this.id)): Promise<void> {
    const path = placement?.path;
    // Deleted elsewhere since it was queued: the tree pass decides what happens to the file.
    // Placed again since: that placement's own reconcile does this.
    if (path === undefined || this.destroyed || !this.engine.vaultIndex.get(this.id) || this.engine.placementOf(this.id) !== placement) return;
    const disk = await this.engine.opts.disk.read(path);
    if (this.engine.placementOf(this.id) !== placement) return;
    // The path was empty when the note was placed, so this file is the user's, its vault event
    // still queued: step back, let the event sync it (a path collision if need be), and retry.
    if (vacant && disk !== null) return this.engine.unplace(this.id);
    if (disk === null) {
      // Placed here before, so deleted here since: its event (or the next scan) decides.
      if (this.base) return;
      this.engine.log("debug", `Placing note ${short(this.id)} (${this.ytext.length} characters)`, path);
      await this.writeNow(null);
      return this.engine.retryTree();
    }
    if (!this.knownLocally && !this.createdHere && this.ytext.length > 0 && disk !== this.ytext.toJSON()) {
      // A blank file holds nothing to keep, e.g. a daily note created before the note synced.
      if (blank(disk)) return this.writeNow(disk);
      const copy = conflictPath(path, this.id);
      this.engine.log("warn", `Kept this device's copy as ${copy}: it differs from the synced version (${difference(disk, this.ytext.toJSON())})`, path);
      await this.engine.createFromDisk(copy, disk, true);
      return this.writeNow(disk);
    }
    // The file here is the note, even if blank, so the server learns it exists.
    if (!hasState(this.doc)) markNote(this.doc);
    this.applyDisk(disk);
    this.engine.retryTree();
  }

  applyDisk(disk: string): void {
    if (this.destroyed) return;
    const current = this.ytext.toJSON();
    if (disk === current) return this.setBase(Y.snapshot(this.doc), disk);
    const base = this.base ?? { snapshot: Y.snapshot(this.doc), text: current };
    if (disk !== base.text) {
      const from = this.ancestor() ?? base;
      proto.record("disk-merge", { path: this.path, from: from.text, disk });
      this.engine.log("debug", `Merging a change made on disk into note ${short(this.id)} (${difference(from.text, disk)})`, this.path);
      const by = this.engine.wasWrittenLocally(this.path, base.text, disk) ? this.human() : this.unknown();
      this.setBase(this.mergeOver(from, disk, by), disk);
    }
    if (this.ytext.toJSON() !== disk) this.scheduleWrite();
  }

  /**
   * What the file's and an editor's text are edits of: the base, or the state an editor
   * showed when it stopped syncing with the note still open, while the base doesn't hold it.
   */
  private ancestor(): TextState | null {
    const shown = this.reopening;
    return shown && !(this.base && contains(this.base.snapshot, shown.snapshot)) ? shown : this.base;
  }

  /** Merges `text` as `by`'s edit of `base`'s text, and returns the state that edit made of the base. */
  private mergeOver(base: TextState, text: string, by: Provenance): Y.Snapshot {
    const fork = Y.createDocFromSnapshot(this.doc, base.snapshot);
    const before = Y.encodeStateVector(fork);
    fork.transact(() => setText(fork.getText(TEXT_KEY), text, by, "literal"));
    // Deletions carry no author, so the journal reads them from the transaction's actor.
    this.doc.transact(() => {
      markActor(this.doc, by.author);
      Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(fork, before), FROM_DISK);
    }, FROM_DISK);
    return Y.snapshot(fork);
  }

  private recordEditorState() {
    this.editorStates.push({ snapshot: Y.snapshot(this.doc), text: this.ytext.toJSON() });
    if (this.editorStates.length > SAVED_STATES) this.editorStates.shift();
  }

  /**
   * A modify event for this file. The text is merged against the base, so an
   * editor's save, whose state `trackWrite` already made the base, adds
   * nothing, and anything else is another program's edit, whether or not the
   * file is open (editors don't push outside changes). A read that a tracked
   * write overlapped may hold the new text with the old base, so it reads again.
   */
  async onDiskModified(): Promise<void> {
    for (;;) {
      const path = this.path;
      // Deleted elsewhere: nothing merges into it, and the tree pass decides about the file.
      if (!path || !this.engine.vaultIndex.get(this.id)) return;
      const events = this.writeEvents;
      const disk = await this.engine.opts.disk.read(path);
      if (disk === null || this.destroyed) return;
      if (this.writes.size) await Promise.allSettled(this.writes);
      else if (events === this.writeEvents) return this.applyDisk(disk);
    }
  }

  /**
   * An editor began a save. The host picks the save's text first and writes
   * it, through trackWrite, only after other file operations finish, so reads
   * of the file wait from here until `done`: the text may be one no CRDT state
   * held, typed before the editor bound.
   */
  saveStarted(done: Promise<unknown>): void {
    const landed = () => {
      this.writes.delete(done);
      this.writeEvents++;
    };
    this.writes.add(done);
    this.writeEvents++;
    done.then(landed, landed);
  }

  /**
   * An editor is about to save `text` to this file. If the CRDT held that
   * text, in its current state or one an editor showed, that state becomes the
   * base once the write lands.
   */
  async trackWrite<T>(text: string, write: () => Promise<T>): Promise<T> {
    const state =
      text === this.ytext.toJSON() ? { snapshot: Y.snapshot(this.doc), text } : [...this.editorStates].reverse().find((s) => s.text === text);
    proto.record("track-write", { path: this.path, found: !!state, editors: this.editors });
    if (!state) {
      // Text typed before the editor bound: merged from the file like another local write, so it is the human's.
      const path = this.path;
      if (path !== undefined) this.engine.wroteLocally(path, (await this.engine.opts.disk.read(path)) ?? "", text);
      return write();
    }
    const run = write();
    this.writes.add(run);
    this.writeEvents++;
    try {
      const out = await run;
      this.setBase(state.snapshot, state.text);
      return out;
    } finally {
      this.writes.delete(run);
      this.writeEvents++;
    }
  }

  /**
   * Binds an editor, as a queued task, and resolves to its release function.
   * While any editor is bound, the editor saves the file. `loaded` is the
   * first editor's text: what the host read from the file, plus anything
   * typed before the editor bound, some of which the editor may already have
   * saved without the CRDT holding it. So the file is merged first, with any
   * other program's edit whose modify event is still pending, and then the
   * editor's text as an edit of the file's, which stays the base. Nothing is
   * awaited after reading `loaded`, so no keystroke falls between that read
   * and the editor pushing its edits. A pane that read the file before
   * writeNow's last write and hasn't reloaded it still holds the replaced
   * text, which is not merged.
   *
   * `shown` is the state an editor showed when it stopped syncing with its
   * note still open, as after an error or a restart of sync, which release
   * also takes. Its text and its saves since are edits of that state, which
   * already holds what it typed before, so they are merged against it.
   */
  bindEditor(loaded: () => string | null = () => null, shown: TextState | null = null): Promise<(shown?: TextState) => void> {
    return this.engine.enqueue(async () => {
      if (shown && this.editors === 0 && textAt(this.doc, shown.snapshot) === shown.text) this.reopening = shown;
      if (this.editors === 0 && this.base) await this.onDiskModified();
      const text = this.editors === 0 && this.base ? loaded() : null;
      const from = this.ancestor();
      const merges = text !== null && from && text !== this.ytext.toJSON() && text !== from.text && text !== this.replaced;
      proto.record("bind", { path: this.path, mode: "text", merges, skippedAsReplaced: text !== null && text === this.replaced, editors: this.editors });
      if (merges) {
        this.engine.log("debug", `Merging the open editor's unsaved text into note ${short(this.id)} (${difference(from.text, text)})`, this.path);
        this.mergeOver(from, text, this.human());
      }
      this.reopening = null;
      this.editors++;
      this.recordEditorState();
      let released = false;
      return (shown?: TextState) => {
        if (released) return;
        released = true;
        if (shown) this.reopening = shown;
        this.editors--;
        this.scheduleWrite();
      };
    });
  }

  /**
   * PROTOTYPE of the edit-log bind. The pane's own edits since its log's text are applied
   * once, on a fork at the state that text names, along with those of the note's other
   * unbound panes, whose copies may be in its text. The pane's text is never merged.
   */
  bindEdits(take: () => Array<{ log: PaneLog; placed: (state: TextState) => void; own: boolean }>): Promise<() => void> {
    return this.engine.enqueue(async () => {
      if (this.base) await this.onDiskModified();
      const logs = take();
      const left = this.applyLogs(logs, "bind");
      const own = left.find((e) => e.own);
      if (own) this.mergeUnplaced(own.log, "bind");
      proto.record("bind", { path: this.path, mode: "edit-log", logs: logs.map((e) => ({ own: e.own, edits: e.log.edits.length })), unplaced: left.length, editors: this.editors });
      this.editors++;
      this.recordEditorState();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.editors--;
        this.scheduleWrite();
      };
    });
  }

  /**
   * PROTOTYPE. Applies each log's edits on a fork at the state its text names, repeating while
   * that places more (a pane's text may hold another pane's edits as a copy). Returns the logs
   * no known state has the text of.
   */
  applyLogs<E extends { log: PaneLog; placed: (state: TextState) => void }>(entries: E[], why: string): E[] {
    let left = entries.filter((e) => e.log.edits.length);
    for (let progress = true; progress && left.length; ) {
      progress = false;
      for (const e of [...left]) {
        const found = e.log.state ? { state: e.log.state, how: "kept from unbind" } : this.stateOfText(e.log.text);
        if (!found) continue;
        e.placed(this.applyEdits(found.state, e.log));
        proto.record("apply-log", { path: this.path, why, how: found.how, edits: e.log.edits.length });
        left = left.filter((x) => x !== e);
        progress = true;
      }
    }
    return left;
  }

  /** PROTOTYPE. Today's text merge, for a log no state can place; recorded as an anomaly. */
  private mergeUnplaced(log: PaneLog, why: string) {
    let after = log.text;
    for (const e of [...log.edits].reverse()) after = after.slice(0, e.from) + e.text + after.slice(e.to);
    proto.anomaly("unanchored-log", { path: this.path, why, logText: log.text, base: this.base?.text, crdt: this.ytext.toJSON(), after });
    this.mergeOver(this.base ?? this.textState(), after, this.human());
  }

  private applyEdits(anchor: TextState, log: PaneLog): TextState {
    const by = this.human();
    const fork = Y.createDocFromSnapshot(this.doc, anchor.snapshot);
    const before = Y.encodeStateVector(fork);
    const text = fork.getText(TEXT_KEY);
    fork.transact(() => {
      let adj = 0;
      for (const e of log.edits) {
        rewriteRange(text, e.from + adj, log.text.slice(e.from, e.to), e.text, by, "literal");
        adj += e.text.length - (e.to - e.from);
      }
    });
    this.doc.transact(() => {
      markActor(this.doc, by.author);
      Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(fork, before), FROM_DISK);
    }, FROM_DISK);
    const state = { snapshot: Y.snapshot(fork), text: text.toJSON() };
    this.editorStates.push(state);
    if (this.editorStates.length > SAVED_STATES) this.editorStates.shift();
    return state;
  }

  /** PROTOTYPE. The newest state the CRDT knows whose text is `text`, and where it was found. */
  private stateOfText(text: string): { state: TextState; how: string } | null {
    if (this.base?.text === text) return { state: this.base, how: "base" };
    if (this.ytext.toJSON() === text) return { state: this.textState(), how: "current" };
    const disk = [...this.diskStates].reverse().find((s) => s.text === text);
    if (disk) return { state: disk, how: "disk history" };
    const shown = [...this.editorStates].reverse().find((s) => s.text === text);
    return shown ? { state: shown, how: "editor state" } : null;
  }

  human() {
    return humanProvenance(this.engine.opts.author, this.engine.opts.device);
  }

  agent(author: AgentId, why: AgentWhy, note: string | null) {
    return agentProvenance(author, why, note, this.engine.opts.device);
  }

  unknown() {
    return unknownProvenance(this.engine.opts.device);
  }

  private scheduleWrite() {
    if (this.editors > 0 || this.destroyed) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.engine.enqueue(() => this.writeNow());
    }, 200);
  }

  /**
   * Writes the CRDT's text over `expected`, the text the file is believed to
   * hold (null: the file is missing). If the file holds something else,
   * another program changed it, so it is merged first and written afterwards.
   */
  async writeNow(expected: string | null | undefined = this.base?.text): Promise<void> {
    const path = this.path;
    if (path === undefined || this.editors > 0 || this.destroyed || expected === undefined) return;
    // A blank note has state (markNote); none means the server never got this note's content.
    if (expected === null && !hasState(this.doc)) return this.engine.log("error", `Not placing note ${short(this.id)}: the server has no content for it`, path);
    const text = this.ytext.toJSON();
    if (expected !== null && this.base?.text === text) return;
    const snapshot = Y.snapshot(this.doc);
    const { disk } = this.engine.opts;
    if (expected === null) await disk.write(path, text);
    else if (!(await disk.writeIfUnchanged(path, expected, text))) {
      void this.engine.enqueue(() => this.onDiskModified());
      return;
    }
    else this.engine.log("debug", "Wrote the synced text to the file", path);
    this.replaced = expected;
    this.setBase(snapshot, text);
  }

  /** Whether the file on disk should already hold the CRDT's text: no editor owns it and no write is waiting. */
  get settled(): boolean {
    return this.editors === 0 && this.writeTimer === null && this.writes.size === 0;
  }

  async flush(): Promise<void> {
    if (!this.writeTimer) return;
    clearTimeout(this.writeTimer);
    this.writeTimer = null;
    await this.writeNow();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopRecording();
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.provider?.destroy();
    this.persistence?.destroy();
    this.doc.destroy();
  }
}

/** Where an id sits on disk. Each placement is a new object, so work queued for an earlier one can tell it is stale. */
export type Placement = { readonly path: string };

/** Which id sits at which path on disk, looked up either way. A path holds one file, so it has one id. */
class DiskMirror {
  private readonly placements = new Map<FileId, Placement>();
  private readonly idAtPath = new Map<string, FileId>();

  get(id: FileId): string | undefined {
    return this.placements.get(id)?.path;
  }

  placement(id: FileId): Placement | undefined {
    return this.placements.get(id);
  }

  has(id: FileId): boolean {
    return this.placements.has(id);
  }

  idAt(path: string): FileId | undefined {
    return this.idAtPath.get(path);
  }

  /** Places `id` at `path`, unplacing whichever id was there before. */
  set(id: FileId, path: string): void {
    if (this.get(id) === path) return;
    const previous = this.idAtPath.get(path);
    if (previous !== undefined) this.delete(previous);
    this.delete(id);
    this.placements.set(id, { path });
    this.idAtPath.set(path, id);
  }

  delete(id: FileId): void {
    const placement = this.placements.get(id);
    if (placement) this.idAtPath.delete(placement.path);
    this.placements.delete(id);
  }

  *[Symbol.iterator](): IterableIterator<[FileId, string]> {
    for (const [id, placement] of this.placements) yield [id, placement.path];
  }
}

const short = (id: FileId) => id.slice(0, 8);

const blank = (text: string) => text.trim() === "";

const echoKey = (op: "rename" | "delete", ...paths: string[]) => [op, ...paths].join("\0");

function synced(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve) => provider.on("synced", () => resolve()));
}

/** The server has applied everything this document holds. `synced` only says its answer arrived, with ours perhaps still on the way. */
function acknowledged(provider: HocuspocusProvider): Promise<void> {
  const done = () => provider.isSynced && !provider.hasUnsyncedChanges;
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!done()) return;
      provider.off("unsyncedChanges", check);
      resolve();
    };
    provider.on("unsyncedChanges", check);
  });
}

interface OpenWeek {
  week: number;
  doc: Y.Doc;
  persistence: Persistence | null;
  provider: HocuspocusProvider | null;
}

function closeWeek({ doc, persistence, provider }: OpenWeek) {
  provider?.destroy();
  persistence?.destroy();
  doc.destroy();
}

/**
 * Keeps a vault folder and the server's CRDT documents in agreement.
 *
 * `onDisk` mirrors which file id currently sits at which path on disk. Every
 * disk operation the engine performs updates the mirror first, so the vault
 * events it triggers find nothing to do. `syncTree` is the single,
 * idempotent pass that moves the disk toward the index. The mirror is also
 * persisted, so a file deleted while the engine wasn't running is recognised as
 * deleted on the next start rather than restored from the server.
 */
export class SyncEngine implements VaultDocs {
  readonly vaultIndex: VaultIndex;
  readonly recorder: Recorder;
  readonly files = new Map<FileId, MarkdownFile>();
  private readonly onDisk = new DiskMirror();
  private readonly binaryHashes = new Map<FileId, string>();
  /** Writes through the Vault API by anything but the engine, per path, until a read accounts for them. */
  private readonly localWrites = new Map<string, Array<{ before: string; after: string }>>();
  private socket: HocuspocusProviderWebsocket | null = null;
  private indexProvider: HocuspocusProvider | null = null;
  private indexPersistence: Persistence | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private treeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Path-collision losers whose content is being compared with the winner's. */
  private readonly settling = new Set<FileId>();
  /** Vault events our own renames and deletions will cause, keyed by echoKey. */
  private readonly echoes = new Set<string>();
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last syncTree left files unplaced behind files not synced yet; vault events retry it. */
  private treeIncomplete = false;
  /** Only this week stays open, so a phone carries one week of the journal in memory. */
  private thisWeek: OpenWeek | null = null;
  /** Weeks this device may hold entries for that the server hasn't confirmed. A past week has no open provider to send them. */
  private unsentWeeks = new Set<number>();
  private stopRecordingIndex: () => void = () => {};
  private weekDropTimer: ReturnType<typeof setInterval> | null = null;
  started = false;

  constructor(readonly opts: EngineOptions) {
    this.vaultIndex = new VaultIndex(new Y.Doc({ gc: false }));
    this.recorder = new Recorder(
      opts.device,
      (at) => this.entriesFor(at),
      (tr) => tr.local || tr.origin === FROM_DISK,
      (week) => this.vaultIndex.markJournalWeek(week),
    );
  }

  get device(): string {
    return this.opts.device;
  }

  /** Whether this week's journal has heard from the server. */
  get isConnected(): boolean {
    return !!this.thisWeek?.provider?.isSynced;
  }

  async index(): Promise<VaultIndex> {
    return this.vaultIndex;
  }

  /** Serialises disk-touching work so passes never interleave. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch((e) => {
      console.error("[provenance-sync]", e);
      this.log("error", errorMessage(e));
    });
    return run;
  }

  log(level: SyncEvent["level"], message: string, path?: string): void {
    this.opts.onEvent?.({ level, message, ...(path === undefined ? {} : { path }) });
  }

  connect(name: string, document: Y.Doc, sessionAwareness = false): HocuspocusProvider | null {
    if (!this.socket) return null;
    const provider = new HocuspocusProvider({ websocketProvider: this.socket, name, document, token: this.opts.server!.token, sessionAwareness });
    provider.attach();
    return provider;
  }

  placementOf(id: FileId): Placement | undefined {
    return this.onDisk.placement(id);
  }

  pathOf(id: FileId): string | undefined {
    return this.onDisk.get(id) ?? this.vaultIndex.get(id)?.path;
  }

  fileAt(path: string): MarkdownFile | undefined {
    const id = this.onDisk.idAt(path);
    return id ? this.files.get(id) : undefined;
  }

  async start(): Promise<void> {
    const { opts } = this;
    if (opts.server) {
      this.socket = new HocuspocusProviderWebsocket({
        url: opts.server.url,
        ...(opts.server.WebSocketPolyfill ? { WebSocketPolyfill: opts.server.WebSocketPolyfill } : {}),
      });
      let last = "";
      this.socket.on("status", ({ status }: { status: string }) => {
        // The provider reports "connected" twice per connection.
        if (status === last) return;
        last = status;
        opts.onStatus?.(status === "connected" ? "connected" : status === "connecting" ? "connecting" : "offline");
        if (status === "connected") this.log("info", `Connected to ${opts.server!.url}`);
      });
      this.socket.on("disconnect", ({ event }: { event?: { code?: number; reason?: string } }) =>
        this.log("warn", `Disconnected from the server (code ${event?.code ?? "?"}${event?.reason ? `, ${event.reason}` : ""})`),
      );
    } else opts.onStatus?.("local-only");

    const indexDoc = this.vaultIndex.doc;
    const name = indexDocName(opts.vault);
    this.indexPersistence = opts.persist?.(name, indexDoc) ?? null;
    await this.indexPersistence?.whenSynced;
    const hadLocal = Y.encodeStateVector(indexDoc).length > 1;
    this.indexProvider = this.connect(name, indexDoc);
    this.indexProvider?.on("authenticationFailed", ({ reason }: { reason: string }) =>
      this.log("error", `The server rejected this device's token for vault "${opts.vault}" (${reason})`),
    );
    // A fresh device must learn the server's file ids before scanning, or
    // every existing file would be uploaded again under a new id. Any other
    // device waits a little too, so the scan sees what was deleted elsewhere
    // while it was off rather than taking the files for edits made here.
    if (!hadLocal && this.indexProvider) await synced(this.indexProvider);
    else if (this.indexProvider) await within(synced(this.indexProvider), OPEN_WAIT, undefined);

    const lastSeen = ((await this.indexPersistence?.get(MIRROR_KEY)) ?? {}) as Record<string, string>;
    this.unsentWeeks = new Set(((await this.indexPersistence?.get(UNSENT_WEEKS_KEY)) ?? []) as number[]);
    this.enterWeek(weekOf(Date.now()));
    await this.thisWeek!.persistence?.whenSynced;
    await this.recallOlderWork(weekOf(Date.now()));
    void this.dropOldWeeks();
    this.weekDropTimer = setInterval(() => void this.dropOldWeeks(), DAY);
    this.stopRecordingIndex = this.recorder.watchIndex(this.vaultIndex.files);
    this.recorder.paused = Object.keys(lastSeen).length === 0;
    await this.enqueue(() => this.scanDisk(lastSeen));
    this.recorder.paused = false;
    this.vaultIndex.files.observe((_e, tr) => {
      if (tr.origin !== FROM_DISK) this.scheduleTree();
    });
    this.started = true;
    await this.enqueue(() => this.syncTree());
  }

  /**
   * Maps files on disk to ids. Paths go through the persisted mirror first,
   * because the index may already carry a remote rename this disk hasn't
   * seen. Mapping and deletion detection happen without awaiting, so the
   * index can't change halfway through.
   */
  private async scanDisk(lastSeen: Record<string, string>): Promise<void> {
    const listed = await this.opts.disk.list();
    const idAt = new Map(Object.entries(lastSeen).map(([id, path]) => [path, id as FileId]));
    const deletedElsewhere = (path: string) => {
      const id = idAt.get(path);
      return id && !this.vaultIndex.get(id) ? id : undefined;
    };
    const untouched = await this.untouchedSince(listed.flatMap((f) => (deletedElsewhere(f.path) ? [{ ...f, id: deletedElsewhere(f.path)! }] : [])));
    const present = new Set(listed.map((f) => f.path));
    const movedAway = await this.movedAway(
      Object.entries(lastSeen).flatMap(([id, path]) => (!untouched.has(path) && !this.vaultIndex.get(id as FileId) ? [id as FileId] : [])),
      listed.filter((f) => !f.binary && !idAt.has(f.path)).map((f) => f.path),
    );

    // The mapping runs without awaiting, but for detectRenames' reads: files go by the mirror,
    // then by content to notes that vanished from their mirrored path (renamed while off),
    // then by the index's paths.
    const unmapped: typeof listed = [];
    const trash: string[] = [];
    for (const file of listed) {
      const remembered = idAt.get(file.path);
      const gone = deletedElsewhere(file.path);
      if (gone && untouched.has(file.path)) trash.push(file.path);
      else if (remembered && !gone && !this.onDisk.has(remembered)) this.onDisk.set(remembered, file.path);
      else unmapped.push(file);
    }
    const vanished = Object.entries(lastSeen)
      .filter(([id, path]) => !present.has(path) && !this.onDisk.has(id as FileId) && this.vaultIndex.get(id as FileId))
      .map(([id]) => id as FileId);
    const renamed = await this.detectRenames(vanished, unmapped);
    const renamedTo = new Set(renamed.values());
    for (const file of unmapped.splice(0)) {
      if (renamedTo.has(file.path)) continue;
      const id = this.vaultIndex.idOf(file.path);
      if (id && !this.onDisk.has(id)) this.onDisk.set(id, file.path);
      else if (movedAway.has(file.path)) trash.push(file.path);
      else unmapped.push(file);
    }
    const deleted = vanished.filter((id) => !renamed.has(id) && !this.onDisk.has(id));
    if (renamed.size || deleted.length) {
      this.vaultIndex.doc.transact(() => {
        for (const [id, path] of renamed) this.vaultIndex.rename(id, path);
        for (const id of deleted) this.vaultIndex.delete(id);
      }, FROM_DISK);
    }
    for (const path of trash) {
      this.log("info", `Moved to the trash: another device deleted ${short(idAt.get(path) ?? movedAway.get(path)!)} while sync was off here`, path);
      await this.opts.disk.trash(path);
    }
    for (const { path } of unmapped) {
      const id = idAt.get(path);
      if (id && !this.vaultIndex.get(id)) this.log("warn", `Kept as a new file: another device deleted ${short(id)} while sync was off, but it was edited here`, path);
    }
    const added = unmapped;
    this.log("info", `Found ${listed.length} files: ${added.length} new, ${renamed.size} renamed and ${deleted.length} deleted since the last run`);
    for (const [id, path] of renamed) this.log("debug", `Renamed ${short(id)} while sync was off`, path);
    for (const id of deleted) this.log("debug", `Deleted ${short(id)} while sync was off`, lastSeen[id]);
    for (const { path } of added) this.log("debug", "Added while sync was off", path);

    for (const { path, binary } of added) await this.addFromDisk(path, binary);
    for (const { path, binary } of listed) {
      const id = binary ? this.onDisk.idAt(path) : undefined;
      const data = id ? await this.opts.disk.readBinary(path) : null;
      if (id && data) this.binaryHashes.set(id, await sha256(data));
    }
  }

  /**
   * Of the files this device last saw as an id that another device has
   * since deleted, the paths of those untouched here since: they go to the
   * trash, as they would have if sync had been running. One edited here is
   * synced as a new file instead. Without this, a deletion made elsewhere
   * while this device was off would come back from here. An attachment
   * keeps no record of its last synced bytes, so it counts as untouched.
   */
  private async untouchedSince(files: Array<{ path: string; binary: boolean; id: FileId }>): Promise<Set<string>> {
    const untouched = new Set<string>();
    for (const { path, binary, id } of files) {
      if (binary) {
        untouched.add(path);
        continue;
      }
      const text = await this.peekDiskText(id);
      if (text !== null && (await this.opts.disk.read(path)) === text) untouched.add(path);
    }
    return untouched;
  }

  /**
   * Notes another device deleted that this device had moved, by a rename the
   * mirror hadn't recorded yet (it is written a second after), found among
   * `paths` by their unchanged text: they go to the trash too.
   */
  private async movedAway(ids: FileId[], paths: string[]): Promise<Map<string, FileId>> {
    const found = new Map<string, FileId>();
    if (!ids.length || !paths.length) return found;
    const texts = new Map<string, FileId>();
    for (const id of ids) {
      const text = await this.peekDiskText(id);
      if (text !== null) texts.set(text, id);
    }
    for (const path of paths) {
      const id = texts.get((await this.opts.disk.read(path)) ?? "");
      if (id && ![...found.values()].includes(id)) found.set(path, id);
    }
    return found;
  }

  /**
   * Files that vanished from their last-seen path while we weren't running,
   * paired with files that appeared, so a rename made in a file manager keeps
   * the file's id and history. Markdown pairs by content similarity, the way
   * git detects renames; attachments by identical content hash.
   */
  private async detectRenames(vanished: FileId[], appeared: Array<{ path: string; binary: boolean }>): Promise<Map<FileId, string>> {
    const renamed = new Map<FileId, string>();
    if (!vanished.length || !appeared.length) return renamed;

    const notes = vanished.filter((id) => this.vaultIndex.get(id)?.type === "markdown");
    const opened = notes.map((id) => this.openFile(id, false));
    await within(Promise.allSettled(opened.map((f) => f.ready)), OPEN_WAIT, []);
    const appearedNotes = [];
    for (const f of appeared.filter((f) => !f.binary)) appearedNotes.push({ key: f.path, text: (await this.opts.disk.read(f.path)) ?? "" });
    for (const [id, path] of pairRenames(
      opened.map((f) => ({ key: f.id, text: f.diskText })),
      appearedNotes,
    )) {
      renamed.set(id, path);
      this.onDisk.set(id, path);
      const file = this.files.get(id)!;
      const placement = this.onDisk.placement(id);
      void file.ready.then(() => this.enqueue(() => file.reconcileDisk(false, placement)));
    }
    for (const file of opened) if (!renamed.has(file.id)) this.closeFile(file.id);

    for (const f of appeared.filter((f) => f.binary)) {
      const data = await this.opts.disk.readBinary(f.path);
      const hash = data && (await sha256(data));
      const id = vanished.find((id) => {
        const entry = this.vaultIndex.get(id);
        return !renamed.has(id) && entry?.type === "binary" && entry.hash === hash;
      });
      if (!id || !hash) continue;
      renamed.set(id, f.path);
      this.onDisk.set(id, f.path);
      this.binaryHashes.set(id, hash);
    }
    return renamed;
  }

  /** Records which files are really on disk, for detecting deletions made while we weren't running. */
  private saveMirror() {
    if (this.mirrorTimer || !this.indexPersistence) return;
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null;
      void this.enqueue(() => this.writeMirror());
    }, 1000);
  }

  private async writeMirror() {
    const seen: Record<string, string> = {};
    for (const { path } of await this.opts.disk.list()) {
      const id = this.onDisk.idAt(path);
      if (id) seen[id] = path;
    }
    await this.indexPersistence?.set(MIRROR_KEY, seen);
  }

  /** Forget that `id` was placed at its path, and have the next vault event retry the tree pass. */
  unplace(id: FileId) {
    this.onDisk.delete(id);
    this.treeIncomplete = true;
  }

  /** After a change on disk, retry a tree pass that left files unplaced. */
  retryTree() {
    if (this.treeIncomplete && this.started) this.scheduleTree();
  }

  private scheduleTree() {
    if (this.treeTimer) return;
    this.treeTimer = setTimeout(() => {
      this.treeTimer = null;
      void this.enqueue(() => this.syncTree());
    }, 50);
  }

  /**
   * Moves the disk toward the index: renames, deletions, new files, changed
   * attachments. Losers of a path collision stay put until settleCollision
   * decides them, and nothing is placed at a path another file holds. Moves
   * that arrive together can wait on each other, as when two notes swap
   * paths, so the pass repeats while it makes progress, and a cycle is broken
   * by parking one file at a temporary path.
   */
  private async syncTree(): Promise<void> {
    const index = this.vaultIndex;
    for (const [id, entry] of index.entries()) {
      const repaired = repairedConflictPath(entry.path, id);
      if (repaired === null) continue;
      this.log("warn", `Renamed a conflict copy whose name was too long to write to ${repaired}`, entry.path);
      index.doc.transact(() => index.rename(id, repaired));
    }
    const losers = new Set(index.conflicts().map(([id]) => id));
    for (const id of losers) void this.settleCollision(id);
    const entries = new Map(index.entries());
    const done = { added: 0, moved: 0, deleted: 0 };
    this.treeIncomplete = false;

    for (const [id, path] of [...this.onDisk]) {
      if (entries.has(id)) continue;
      const changed = await this.changedHere(id, path);
      this.forget(id);
      if (changed) {
        // Edited or replaced here, maybe with its events still queued: keep it, as a new file.
        this.log("warn", `Kept as a new file: another device deleted ${short(id)}, but the file here changed since`, path);
        await this.addFromDisk(path, !isMarkdownPath(path));
        continue;
      }
      this.log("debug", `Moving to the trash: another device deleted ${short(id)}`, path);
      await this.expectEcho(echoKey("delete", path), () => this.opts.disk.trash(path));
      done.deleted++;
    }
    for (;;) {
      const before = done.added + done.moved;
      const blocked: Array<[FileId, string, FileId]> = [];
      for (const [id, entry] of entries) {
        if (losers.has(id) || !this.opts.disk.accepts(entry.path)) continue;
        const holder = this.onDisk.idAt(entry.path);
        if (holder !== undefined && holder !== id) {
          blocked.push([id, entry.path, holder]);
          continue;
        }
        const current = this.onDisk.get(id);
        if (current !== undefined && current !== entry.path) {
          // Deleted, replaced or edited here, its events still queued: they go first, with the
          // id where they will look for it, and a vault event retries the move.
          // A file not synced yet at the new path, its create event likely queued: the same.
          if (!(await this.opts.disk.exists(current)) || (await this.changedHere(id, current)) || (await this.opts.disk.exists(entry.path))) {
            this.treeIncomplete = true;
            continue;
          }
          this.onDisk.set(id, entry.path);
          this.log("debug", `Moving ${short(id)} from ${current}`, entry.path);
          await this.expectEcho(echoKey("rename", current, entry.path), () => this.opts.disk.rename(current, entry.path));
          done.moved++;
        }
        if (entry.type === "markdown") {
          if (!this.files.has(id) || current === undefined) {
            const vacant = current === undefined && !(await this.opts.disk.exists(entry.path));
            this.onDisk.set(id, entry.path);
            const placement = this.onDisk.placement(id);
            const file = this.openFile(id, false);
            void file.ready.then(() => this.enqueue(() => file.reconcileDisk(vacant, placement)));
            if (current === undefined) done.added++;
          }
        } else if (await this.syncBinary(id, entry)) done.added++;
      }
      // A holder that is a collision loser is settleCollision's to move.
      const waiting = blocked.filter(([, , holder]) => !losers.has(holder));
      if (!waiting.length) break;
      if (done.added + done.moved > before) continue;
      const parked = waiting.find(([, , holder]) => entries.get(holder) && entries.get(holder)!.path !== this.onDisk.get(holder));
      if (!parked) {
        for (const [id, path, holder] of waiting) this.log("warn", `Can't place ${short(id)}: ${short(holder)} is there and isn't moving`, path);
        this.treeIncomplete = true;
        break;
      }
      const [, path, holder] = parked;
      const temp = conflictPath(path, holder);
      if (await this.opts.disk.exists(temp)) {
        this.treeIncomplete = true;
        break;
      }
      this.onDisk.set(holder, temp);
      this.log("debug", `Moving ${short(holder)} aside to ${temp}, so the moves waiting on each other can go ahead`, path);
      await this.expectEcho(echoKey("rename", path, temp), () => this.opts.disk.rename(path, temp));
    }
    if (done.added || done.moved || done.deleted) {
      this.log("info", `Applied from the index: ${done.added} new or changed, ${done.moved} moved, ${done.deleted} deleted`);
    }
    this.saveMirror();
  }

  /** Whether the file at `path` differs from what this device last synced there as `id`. */
  private async changedHere(id: FileId, path: string): Promise<boolean> {
    const file = this.files.get(id);
    if (file) {
      const text = await this.opts.disk.read(path);
      return text !== null && text !== file.diskText;
    }
    const known = this.binaryHashes.get(id);
    const data = known && (await this.opts.disk.readBinary(path));
    return !!data && (await sha256(data)) !== known;
  }

  /**
   * Two devices created a file at the same path, and the smallest id keeps
   * it. If both hold the same content, the loser is dropped and the winner
   * takes over its file on disk. A blank note is dropped the same way, winner
   * or not, so the other note keeps the path. Otherwise the loser moves to a
   * conflict copy.
   */
  private async settleCollision(loser: FileId): Promise<void> {
    if (this.settling.has(loser)) return;
    this.settling.add(loser);
    try {
      const winnerOf = () => {
        const entry = this.vaultIndex.get(loser);
        const winner = entry && this.vaultIndex.idOf(entry.path);
        return winner === loser ? undefined : winner;
      };
      const winner = winnerOf();
      // No longer a loser (the winner moved or went): the pass that skipped it places it now.
      if (!winner) return this.scheduleTree();
      const redundant = await this.redundant(loser, winner);
      await this.enqueue(async () => {
        const entry = this.vaultIndex.get(loser);
        if (!entry || winnerOf() !== winner) return;
        if (redundant) await this.dropDuplicate(redundant, redundant === loser ? winner : loser);
        else {
          const copy = conflictPath(entry.path, loser);
          this.log("warn", `Two devices created ${entry.path} with different content; moved one to ${copy}`, entry.path);
          this.vaultIndex.doc.transact(() => this.vaultIndex.rename(loser, copy));
        }
        await this.syncTree();
      });
    } finally {
      this.settling.delete(loser);
    }
  }

  /** Which of two colliding files can go without losing anything: the loser if both hold the same content, else a blank note. */
  private async redundant(loser: FileId, winner: FileId): Promise<FileId | undefined> {
    const el = this.vaultIndex.get(loser);
    const ew = this.vaultIndex.get(winner);
    if (el?.type !== "markdown" || ew?.type !== "markdown") return el?.type === "binary" && ew?.type === "binary" && el.hash === ew.hash ? loser : undefined;
    const [fl, fw] = [this.openFile(loser, false), this.openFile(winner, false)];
    await Promise.all([fl.ready, fw.ready]);
    const [tl, tw] = [fl.ytext.toJSON(), fw.ytext.toJSON()];
    // A blank note holds nothing to keep, e.g. a daily note created before the other device's note synced.
    if (tl === tw || blank(tl)) return loser;
    return blank(tw) ? winner : undefined;
  }

  private async dropDuplicate(dropped: FileId, kept: FileId): Promise<void> {
    const path = this.onDisk.get(dropped);
    const file = this.files.get(dropped);
    const droppedText = file?.ytext.toJSON();
    // Same text, but the dropped copy may know who wrote parts the kept one has as unknown, e.g. one device's copy was imported from disk.
    if (file && this.vaultIndex.get(kept)?.type === "markdown") {
      const keptFile = this.openFile(kept, false);
      keptFile.doc.transact(() => adoptText(keptFile.ytext, file.ytext, true));
    }
    this.closeFile(dropped);
    // If the kept copy isn't on disk yet, it takes over the dropped copy's file; otherwise the next pass trashes that file.
    if (path !== undefined && !this.onDisk.has(kept)) {
      this.onDisk.delete(dropped);
      this.onDisk.set(kept, path);
      const entry = this.vaultIndex.get(kept)!;
      if (entry.type === "binary") this.binaryHashes.set(kept, entry.hash);
      else {
        const keptFile = this.openFile(kept, false);
        const text = await this.opts.disk.read(path);
        if (text === null) await keptFile.writeNow(null);
        // Still the dropped copy's text (a blank note's, if the copies differ): the kept text replaces it.
        else if (text === droppedText) await keptFile.writeNow(text);
        else keptFile.applyDisk(text);
      }
    }
    this.binaryHashes.delete(dropped);
    this.vaultIndex.doc.transact(() => this.vaultIndex.delete(dropped), FROM_DISK);
    this.log("info", `Dropped a redundant copy of ${this.vaultIndex.get(kept)!.path} created on another device`);
  }

  private openFile(id: FileId, createdHere: boolean): MarkdownFile {
    let file = this.files.get(id);
    if (!file) {
      file = new MarkdownFile(id, this, createdHere);
      this.files.set(id, file);
    }
    return file;
  }

  private closeFile(id: FileId): void {
    this.files.get(id)?.destroy();
    this.files.delete(id);
  }

  /** Runs `fn` on a note, leaving it as open or closed as it was; null if the note didn't load in time. */
  private async peek<T>(id: FileId, fn: (file: MarkdownFile) => T): Promise<T | null> {
    const kept = this.files.has(id);
    const file = this.openFile(id, false);
    const ready = await within(file.ready.then(() => true), OPEN_WAIT, false);
    const out = ready ? fn(file) : null;
    if (!kept) this.closeFile(id);
    return out;
  }

  /** The text this device last had on disk for a note it doesn't keep open, or null if the note didn't load in time. */
  private peekDiskText(id: FileId): Promise<string | null> {
    return this.peek(id, (file) => file.diskText);
  }

  /** Drops everything this device knows about `id` being on disk. */
  private forget(id: FileId): void {
    this.onDisk.delete(id);
    this.closeFile(id);
    this.binaryHashes.delete(id);
  }

  /** Runs our own rename or deletion of a file that exists, noting the vault event it will cause. */
  private async expectEcho(key: string, op: () => Promise<void>): Promise<void> {
    const path = key.split("\0")[1]!;
    if (!(await this.opts.disk.exists(path))) return;
    this.echoes.add(key);
    try {
      await op();
    } catch (e) {
      this.echoes.delete(key);
      throw e;
    }
  }

  /** Resolves to whether it wrote the attachment. */
  private async syncBinary(id: FileId, entry: Extract<FileEntry, { type: "binary" }>): Promise<boolean> {
    if (this.binaryHashes.get(id) === entry.hash || !this.opts.server) return false;
    this.log("debug", `Downloading attachment ${short(id)} (${entry.size} bytes)`, entry.path);
    const data = await this.opts.server.blobs.get(entry.hash);
    this.onDisk.set(id, entry.path);
    this.binaryHashes.set(id, entry.hash);
    await this.opts.disk.writeBinary(entry.path, data);
    return true;
  }

  async createFromDisk(path: string, text: string, alsoWrite: boolean): Promise<MarkdownFile> {
    const id = newFileId();
    this.onDisk.set(id, path);
    const file = this.openFile(id, true);
    markNote(file.doc);
    file.applyDisk(text);
    this.vaultIndex.doc.transact(() => this.vaultIndex.set(id, { type: "markdown", path }), FROM_DISK);
    if (alsoWrite) await this.opts.disk.write(path, text);
    return file;
  }

  /** Starts syncing a file found on disk under a new id. */
  private async addFromDisk(path: string, binary: boolean): Promise<void> {
    if (binary) return this.uploadBinary(path, undefined);
    await this.createFromDisk(path, (await this.opts.disk.read(path)) ?? "", false);
  }

  private async uploadBinary(path: string, known: FileId | undefined): Promise<void> {
    if (!this.opts.server) return;
    const data = await this.opts.disk.readBinary(path);
    if (!data) return;
    const hash = await sha256(data);
    const id = known ?? newFileId();
    if (this.binaryHashes.get(id) === hash) return;
    this.log("debug", `Uploading attachment ${short(id)} (${data.byteLength} bytes)`, path);
    this.onDisk.set(id, path);
    this.binaryHashes.set(id, hash);
    await this.opts.server.blobs.put(hash, data);
    const entry: FileEntry = { type: "binary", path, hash, size: data.byteLength, mtime: Date.now() };
    this.vaultIndex.doc.transact(() => this.vaultIndex.set(id, entry), FROM_DISK);
  }

  /**
   * Compares every file on disk with the index and every index entry with
   * the disk, rather than trusting that vault events covered every change.
   * Logs each disagreement and repairs it the way the matching vault event
   * or the startup scan would have. Resolves to the number found.
   */
  check(): Promise<number> {
    this.log("info", "Check started; it runs once sync work already queued is done");
    return this.enqueue(async () => {
      if (!this.started) return 0;
      const { disk } = this.opts;
      const losers = new Set(this.vaultIndex.conflicts().map(([id]) => id));
      const listed = await disk.list();
      let problems = 0;
      const problem = (message: string, path: string) => {
        problems++;
        this.log("warn", `Check: ${message}`, path);
      };
      for (const { path, binary } of listed) {
        const id = this.onDisk.idAt(path);
        const entry = id && this.vaultIndex.get(id);
        if (!id) {
          problem("this file isn't synced; adding it", path);
          await this.addFromDisk(path, binary);
        } else if (!entry) problem(`${short(id)} was deleted elsewhere but is still here`, path);
        else if (entry.path !== path && !losers.has(id)) problem(`${short(id)} should be at ${entry.path}`, path);
        else if (entry.type === "binary") {
          const data = await disk.readBinary(path);
          const hash = data && (await sha256(data));
          if (hash && hash !== entry.hash) {
            const changedHere = hash !== this.binaryHashes.get(id);
            problem(`attachment ${short(id)} differs from the synced one; ${changedHere ? "uploading this one" : "downloading"}`, path);
            if (changedHere) await this.uploadBinary(path, id);
          }
        } else {
          const file = this.files.get(id);
          if (!file) problem(`note ${short(id)} has no open document`, path);
          else if (file.loaded && file.settled) {
            const text = await disk.read(path);
            if (text !== null && text !== file.ytext.toJSON()) {
              problem(`note ${short(id)} differs from the synced text (${difference(text, file.ytext.toJSON())}); merging`, path);
              // Reads again if a save overlapped, like a modify event would.
              await file.onDiskModified();
            }
          }
        }
      }
      const present = new Set(listed.map((f) => f.path));
      for (const [id, entry] of this.vaultIndex.entries()) {
        if (losers.has(id) || !disk.accepts(entry.path) || present.has(entry.path)) continue;
        problem(`${short(id)} is synced but missing on disk; placing it`, entry.path);
        // Its deletion went unseen, so the index still wants it.
        if (this.onDisk.get(id) !== entry.path) continue;
        if (entry.type === "binary") this.binaryHashes.delete(id);
        else await this.files.get(id)?.writeNow(null);
      }
      await this.syncTree();
      const fingerprint = (await sha256(new TextEncoder().encode(this.indexLines().join("\n")).buffer)).slice(0, 12);
      const summary = `${listed.length} files on disk, ${this.vaultIndex.entries().length} in the index (fingerprint ${fingerprint})`;
      if (problems) this.log("warn", `Check found ${problems} problems and repaired what it could. ${summary}`);
      else this.log("info", `Check: disk and index agree. ${summary}`);
      return problems;
    });
  }

  /** The index as sorted lines; devices whose indexes agree produce the same lines. */
  indexLines(): string[] {
    return this.vaultIndex
      .entries()
      .map(([id, e]) => `${id}\t${e.type}\t${e.path}${e.type === "binary" ? `\t${e.hash}` : ""}`)
      .sort();
  }

  // Vault events from the host. Each is a no-op when it is the echo of our own
  // disk operation. A rename or delete echo runs after the pass that caused
  // it, which may already have put another file at that path, so those are
  // recognised from `echoes` rather than by which id the path maps to now.

  onCreate(path: string, binary: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.retryTree();
      const held = this.fileAt(path);
      if (this.started && held?.loaded && !hasState(held.doc)) return held.reconcileDisk();
      // Gone already: the rename or deletion queued after this event deals with it.
      if (!this.started || this.onDisk.idAt(path) || !(await this.opts.disk.exists(path))) return;
      this.log("debug", "Created here", path);
      if (binary) return this.uploadBinary(path, undefined);
      await this.addFromDisk(path, false);
      this.saveMirror();
    });
  }

  onModify(path: string, binary: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.retryTree();
      const id = this.onDisk.idAt(path);
      if (!this.started || !id) return;
      if (binary) return this.uploadBinary(path, id);
      await this.files.get(id)?.onDiskModified();
    });
  }

  onRename(from: string, to: string): Promise<void> {
    return this.enqueue(async () => {
      this.retryTree();
      const id = this.onDisk.idAt(from);
      if (this.echoes.delete(echoKey("rename", from, to)) || !this.started) return;
      if (!id) {
        // The file wasn't synced at its old path, as when another device's deletion of it
        // was applied while this rename waited in the queue: sync it as a new file.
        if (this.onDisk.idAt(to) || !this.opts.disk.accepts(to) || !(await this.opts.disk.exists(to))) return;
        this.log("debug", `Renamed here from ${from}, which wasn't synced; adding it`, to);
        if (!isMarkdownPath(to)) return this.uploadBinary(to, undefined);
        await this.addFromDisk(to, false);
        return this.saveMirror();
      }
      // Stale: a tree pass queued before the rename moved the note back to `from`.
      if (!(await this.opts.disk.exists(to)) && (await this.opts.disk.exists(from)) && !(await this.changedHere(id, from))) return;
      this.log("debug", `Renamed ${short(id)} here from ${from}`, to);
      this.onDisk.set(id, to);
      this.vaultIndex.doc.transact(() => this.vaultIndex.rename(id, to), FROM_DISK);
      this.saveMirror();
      // A reconcileDisk that found the old path empty left any change made while closed unmerged.
      await this.files.get(id)?.onDiskModified();
    });
  }

  /** An editor began a save of `path` that settles with `done`; see MarkdownFile.saveStarted. */
  saveStarted(path: string, done: Promise<unknown>): void {
    this.fileAt(path)?.saveStarted(done);
  }

  /** An editor is about to save `text` to `path`; see MarkdownFile.trackWrite. */
  trackWrite<T>(path: string, text: string, write: () => Promise<T>): Promise<T> {
    const file = this.fileAt(path);
    return file ? file.trackWrite(text, write) : write();
  }

  /**
   * Another plugin, or Obsidian itself, is about to write `after` over
   * `before` at `path` through the Vault API. When the engine next reads the
   * file, the change is the human's if these writes explain it exactly.
   */
  wroteLocally(path: string, before: string, after: string): void {
    if (before === after) return;
    let writes = this.localWrites.get(path);
    if (!writes) this.localWrites.set(path, (writes = []));
    writes.push({ before, after });
    if (writes.length > LOCAL_WRITES_KEPT) writes.shift();
  }

  /**
   * Whether local writes at `path`, in the order they were made, turn `from`
   * (the text the engine last saw there) into `to` (the text it reads now).
   * Any other change, such as another program's edit landing in between,
   * leaves the merge unknown. Forgets the writes it used.
   */
  wasWrittenLocally(path: string | undefined, from: string, to: string): boolean {
    const writes = path === undefined ? undefined : this.localWrites.get(path);
    if (!writes) return false;
    const used = new Set<{ before: string; after: string }>();
    let text = from;
    for (const write of writes) {
      if (write.before !== text) continue;
      used.add(write);
      text = write.after;
      if (text === to) break;
    }
    if (text !== to) return false;
    const rest = writes.filter((write) => !used.has(write));
    if (rest.length) this.localWrites.set(path!, rest);
    else this.localWrites.delete(path!);
    return true;
  }

  onDelete(path: string): Promise<void> {
    return this.enqueue(async () => {
      this.retryTree();
      const id = this.onDisk.idAt(path);
      if (this.echoes.delete(echoKey("delete", path)) || !this.started || !id) return;
      // Stale: the engine has since put this very note there, e.g. a remote rename to this path.
      if ((await this.opts.disk.exists(path)) && !(await this.changedHere(id, path))) return;
      this.log("debug", `Deleted ${short(id)} here`, path);
      this.forget(id);
      this.vaultIndex.doc.transact(() => this.vaultIndex.delete(id), FROM_DISK);
      this.saveMirror();
    });
  }

  /**
   * Resolves the conflict copy at `copy` into the note at `original` through
   * their CRDTs, so the original keeps the copy's authors; copying the file's
   * Markdown would mark all of it unknown. With `keepText` the original's
   * text stays and only learns authors from the copy; otherwise it becomes
   * the copy's text. The copy itself is left for the caller to trash.
   * Resolves to false if either isn't a synced note, for the caller to fall
   * back to plain file operations.
   */
  adoptCopy(original: string, copy: string, keepText: boolean): Promise<boolean> {
    return this.enqueue(async () => {
      const [target, source] = [original, copy].map((path) => {
        const id = this.onDisk.idAt(path);
        return id && this.vaultIndex.get(id)?.type === "markdown" ? this.files.get(id) : undefined;
      });
      if (!target?.loaded || !source?.loaded) return false;
      // Either file may hold an edit whose modify event is still queued; the user decided on what the files hold.
      for (const file of [target, source]) {
        if ((await this.opts.disk.read(file.path!)) !== file.ytext.toJSON()) await file.onDiskModified();
      }
      target.doc.transact(() => adoptText(target.ytext, source.ytext, keepText));
      this.log("info", `Resolved conflict copy ${copy} into the note, keeping its authors`, original);
      // Written now, so a rescan of the conflict copies sees the result.
      await target.flush();
      return true;
    });
  }

  // VaultDocs, for agent edits arriving through the CLI handler.

  async updateIndex(fn: (index: VaultIndex) => void): Promise<void> {
    this.vaultIndex.doc.transact(() => fn(this.vaultIndex));
    await this.enqueue(() => this.syncTree());
  }

  /** A note new to this device has no text until the server sends it, which may be never while offline. */
  private async arrived(file: MarkdownFile) {
    if (!(await within(file.ready.then(() => true), AGENT_OPEN_WAIT, false))) throw new OpError("unavailable", "this note's text hasn't reached this device yet. It will once sync reconnects.");
  }

  async readText(id: FileId): Promise<Y.Text> {
    const file = this.openFile(id, false);
    await this.arrived(file);
    return file.ytext;
  }

  async updateText<T>(id: FileId, fn: (ytext: Y.Text) => T): Promise<T> {
    // An id the index doesn't know yet is a file an agent is creating right now.
    const file = this.openFile(id, !this.vaultIndex.get(id));
    await this.arrived(file);
    let out!: T;
    file.doc.transact(() => (out = fn(file.ytext)));
    return out;
  }

  /** The queue keeps a tree pass from opening a note in the moment a peek closes it. */
  peekText<T>(id: FileId, fn: (ytext: Y.Text) => T): Promise<T | null> {
    const peek = () => this.peek(id, (file) => fn(file.ytext));
    return this.files.has(id) ? peek() : this.enqueue(peek);
  }

  async week(n: number): Promise<{ entries: Entry[]; complete: boolean }> {
    const open = this.thisWeek;
    if (open?.week === n) return { entries: parseEntries(entriesOf(open.doc).toArray()), complete: !open.provider || open.provider.isSynced };
    return this.pastWeek(n);
  }

  private openWeek(week: number): OpenWeek {
    const name = journalDocName(this.opts.vault, week);
    const doc = new Y.Doc({ gc: false });
    return { week, doc, persistence: this.opts.persist?.(name, doc) ?? null, provider: null };
  }

  /** A past week, open for as long as it takes to read it, and to send what the server is missing. */
  private async pastWeek(n: number): Promise<{ entries: Entry[]; complete: boolean }> {
    // Outside the cache there's no persistence, so reading old history doesn't refill it.
    const week = this.keepsWeek(n) ? this.openWeek(n) : { week: n, doc: new Y.Doc({ gc: false }), persistence: null, provider: null };
    try {
      await week.persistence?.whenSynced;
      // This week's provider answers for the server. Waiting on each past week would use up a read while offline.
      // Each read gets a session of its own: on one socket, a provider opened as the last one closes loses its handshake to the closing connection.
      if (this.isConnected) week.provider = this.connect(journalDocName(this.opts.vault, n), week.doc, true);
      const sent = week.provider ? await within(acknowledged(week.provider).then(() => true), OPEN_WAIT, false) : false;
      if (sent) this.confirmSent(n);
      return { entries: parseEntries(entriesOf(week.doc).toArray()), complete: !this.socket || sent };
    } finally {
      closeWeek(week);
    }
  }

  /** A week the server hasn't confirmed stays whatever its age: here may be its only copy. */
  private keepsWeek(n: number): boolean {
    return this.unsentWeeks.has(n) || n >= oldestWeek(this.opts.localHistoryDays?.() ?? LOCAL_HISTORY_DAYS, Date.now());
  }

  /** Drops weeks past this device's limit from its storage, always whole. The server still has them, and a read goes through to it. */
  async dropOldWeeks(): Promise<void> {
    const { stored, vault } = this.opts;
    if (!stored) return;
    try {
      const names = (await stored.names()) ?? this.vaultIndex.weeks().map((week) => journalDocName(vault, week));
      for (const name of names) {
        const week = journalWeekOf(name);
        if (week !== null && name === journalDocName(vault, week) && !this.keepsWeek(week)) await stored.drop(name);
      }
    } catch (e) {
      this.log("warn", `Couldn't drop old history from this device: ${errorMessage(e)}`);
    }
  }

  private saveUnsentWeeks() {
    void this.indexPersistence?.set(UNSENT_WEEKS_KEY, [...this.unsentWeeks]);
  }

  private confirmSent(week: number) {
    if (this.unsentWeeks.delete(week)) this.saveUnsentWeeks();
  }

  private enterWeek(week: number) {
    if (this.thisWeek) closeWeek(this.thisWeek);
    const open = this.openWeek(week);
    this.thisWeek = open;
    this.unsentWeeks.add(week);
    this.saveUnsentWeeks();
    open.provider = this.connect(journalDocName(this.opts.vault, week), open.doc);
    if (!open.provider) return;
    void synced(open.provider).then(() => {
      for (const past of this.unsentWeeks) if (past !== week) void this.pastWeek(past);
    });
  }

  /** Offline work can span weeks, and the recorder still has to end it when this device next hears from another. */
  private async recallOlderWork(week: number) {
    const older = [...new Set([week - 1, ...this.unsentWeeks])].filter((n) => n < week && this.keepsWeek(n)).sort((a, b) => a - b);
    for (const n of older) {
      const held = this.openWeek(n);
      await held.persistence?.whenSynced;
      this.recorder.carry(parseEntries(entriesOf(held.doc).toArray()));
      closeWeek(held);
    }
  }

  private entriesFor(at: number): Y.Array<Entry> {
    if (this.thisWeek?.week !== weekOf(at)) this.enterWeek(weekOf(at));
    return entriesOf(this.thisWeek!.doc);
  }

  /**
   * Resolves once queued disk work and pending writes are done; for tests and
   * shutdown. Files still waiting for the server (offline, fresh device) are
   * not waited for longer than `wait` ms.
   */
  async settle(wait = OPEN_WAIT): Promise<void> {
    if (this.treeTimer) {
      clearTimeout(this.treeTimer);
      this.treeTimer = null;
      await this.enqueue(() => this.syncTree());
    }
    await within(Promise.allSettled([...this.files.values()].map((f) => f.ready)), wait, []);
    await this.enqueue(async () => {
      for (const f of this.files.values()) await f.flush();
      if (this.mirrorTimer) {
        clearTimeout(this.mirrorTimer);
        this.mirrorTimer = null;
        await this.writeMirror();
      }
    });
  }

  destroy(): void {
    if (this.treeTimer) clearTimeout(this.treeTimer);
    if (this.mirrorTimer) clearTimeout(this.mirrorTimer);
    if (this.weekDropTimer) clearInterval(this.weekDropTimer);
    for (const f of this.files.values()) f.destroy();
    this.files.clear();
    this.stopRecordingIndex();
    if (this.thisWeek) closeWeek(this.thisWeek);
    this.thisWeek = null;
    this.indexProvider?.destroy();
    this.indexPersistence?.destroy();
    this.socket?.destroy();
  }
}
