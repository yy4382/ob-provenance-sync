import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
  conflictPath,
  fileDocName,
  humanProvenance,
  indexDocName,
  newFileId,
  setText,
  TEXT_KEY,
  unknownProvenance,
  VaultIndex,
  type FileEntry,
  type FileId,
  type HumanId,
  type VaultDocs,
} from "@provenance/core";
import * as Y from "yjs";

/** The vault's files as the engine sees them; Obsidian's vault API in the plugin, a Map in tests. */
export interface Disk {
  /** Whether a path belongs to the synced vault (the config folder doesn't). */
  accepts(path: string): boolean;
  list(): Promise<Array<{ path: string; binary: boolean }>>;
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer | null>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
}

export interface Blobs {
  put(hash: string, data: ArrayBuffer): Promise<void>;
  get(hash: string): Promise<ArrayBuffer>;
}

/** Local storage for one document (IndexedDB in Obsidian), plus small per-document values. */
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
  onStatus?: (status: SyncStatus) => void;
}

export type SyncStatus = "offline" | "connecting" | "connected" | "local-only";

/** Transaction origin for changes we read off disk, so they are not written straight back. */
export const FROM_DISK = Symbol("from-disk");

export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BASE_KEY = "disk-base";
const SAVED_STATES = 64;

/** A snapshot is usable only if the document holds every update it refers to. */
function textAt(doc: Y.Doc, snapshot: Y.Snapshot): string | null {
  for (const [client, clock] of snapshot.sv) if (clock > Y.getState(doc.store, client)) return null;
  try {
    return Y.createDocFromSnapshot(doc, snapshot).getText(TEXT_KEY).toJSON();
  } catch {
    return null;
  }
}
const MIRROR_KEY = "on-disk";

/**
 * One markdown file's CRDT replica.
 *
 * `base` is the CRDT state the file on disk last matched, persisted next to
 * the document. A disk change is applied as a three-way merge: replay
 * diff(base, disk) on a fork taken at the base and merge the fork back, so
 * remote changes that haven't reached the disk yet are kept rather than
 * reverted. Disk writes are debounced and skipped while an editor is bound,
 * because then the editor owns saving; meanwhile `editorStates` remembers
 * the states the editor may save, so its saves still move the base forward.
 */
export class MarkdownFile {
  readonly doc = new Y.Doc({ gc: false });
  readonly ytext = this.doc.getText(TEXT_KEY);
  readonly ready: Promise<void>;
  private base: { snapshot: Y.Snapshot; text: string } | null = null;
  private readonly editorStates: Array<{ snapshot: Y.Snapshot; text: string }> = [];
  private editors = 0;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private provider: HocuspocusProvider | null = null;
  private persistence: Persistence | null = null;
  private destroyed = false;
  private knownLocally = false;

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
  }

  private setBase(snapshot: Y.Snapshot, text: string) {
    if (this.destroyed) return;
    this.base = { snapshot, text };
    void this.persistence?.set(BASE_KEY, Y.encodeSnapshot(snapshot));
  }

  /**
   * Brings the file on disk and the CRDT together when the engine first
   * places it. A fresh device (no local history, content fetched from the
   * server) keeps a differing local file as a conflict copy instead of merging.
   */
  async reconcileDisk(): Promise<void> {
    const path = this.path;
    if (path === undefined || this.destroyed) return;
    const disk = await this.engine.opts.disk.read(path);
    if (disk === null) return this.writeNow();
    if (!this.knownLocally && !this.createdHere && this.ytext.length > 0 && disk !== this.ytext.toJSON()) {
      await this.engine.createFromDisk(conflictPath(path, this.id), disk, true);
      return this.writeNow();
    }
    this.applyDisk(disk);
  }

  applyDisk(disk: string): void {
    if (this.destroyed) return;
    const current = this.ytext.toJSON();
    if (disk === current) return this.setBase(Y.snapshot(this.doc), disk);
    const base = this.base ?? { snapshot: Y.snapshot(this.doc), text: current };
    if (disk !== base.text) {
      const fork = Y.createDocFromSnapshot(this.doc, base.snapshot);
      const before = Y.encodeStateVector(fork);
      setText(fork.getText(TEXT_KEY), disk, unknownProvenance(this.engine.opts.device));
      Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(fork, before), FROM_DISK);
      this.setBase(Y.snapshot(fork), disk);
    }
    if (this.ytext.toJSON() !== disk) this.scheduleWrite();
  }

  private recordEditorState() {
    this.editorStates.push({ snapshot: Y.snapshot(this.doc), text: this.ytext.toJSON() });
    if (this.editorStates.length > SAVED_STATES) this.editorStates.shift();
  }

  /**
   * A modify event for this file. A save by an editor matches a state the
   * editor held, possibly an older one if more edits landed since; that state
   * becomes the base. While an editor is bound anything else reaches us
   * through the editor, which Obsidian reloads.
   */
  async onDiskModified(): Promise<void> {
    if (!this.path) return;
    const disk = await this.engine.opts.disk.read(this.path);
    if (disk === null || this.destroyed) return;
    const saved = [...this.editorStates].reverse().find((s) => s.text === disk);
    if (saved) {
      this.setBase(saved.snapshot, saved.text);
      if (this.ytext.toJSON() !== disk) this.scheduleWrite();
      return;
    }
    if (this.editors === 0) this.applyDisk(disk);
  }

  /** Returns a release function. While any editor is bound, the editor saves the file. */
  bindEditor(): () => void {
    this.editors++;
    this.recordEditorState();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.editors--;
      this.scheduleWrite();
    };
  }

  human() {
    return humanProvenance(this.engine.opts.author, this.engine.opts.device);
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

  async writeNow(): Promise<void> {
    const path = this.path;
    if (path === undefined || this.editors > 0 || this.destroyed) return;
    const text = this.ytext.toJSON();
    if (this.base?.text === text) return;
    const snapshot = Y.snapshot(this.doc);
    await this.engine.opts.disk.write(path, text);
    this.setBase(snapshot, text);
  }

  async flush(): Promise<void> {
    if (!this.writeTimer) return;
    clearTimeout(this.writeTimer);
    this.writeTimer = null;
    await this.writeNow();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.provider?.destroy();
    this.persistence?.destroy();
    this.doc.destroy();
  }
}

function synced(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve) => provider.on("synced", () => resolve()));
}

/**
 * Keeps a vault folder and the server's CRDT documents in agreement.
 *
 * `onDisk` mirrors which file id currently sits at which path on disk. Every
 * disk operation the engine performs updates the mirror first, so the vault
 * events it triggers find nothing to do. `syncTree` is the single,
 * idempotent pass that moves the disk toward the index. The mirror is also
 * persisted, so a file deleted while Obsidian was closed is recognised as
 * deleted on the next start rather than restored from the server.
 */
export class SyncEngine implements VaultDocs {
  readonly vaultIndex: VaultIndex;
  readonly files = new Map<FileId, MarkdownFile>();
  private readonly onDisk = new Map<FileId, string>();
  private readonly binaryHashes = new Map<FileId, string>();
  private socket: HocuspocusProviderWebsocket | null = null;
  private indexProvider: HocuspocusProvider | null = null;
  private indexPersistence: Persistence | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private treeTimer: ReturnType<typeof setTimeout> | null = null;
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(readonly opts: EngineOptions) {
    this.vaultIndex = new VaultIndex(new Y.Doc({ gc: false }));
  }

  get device(): string {
    return this.opts.device;
  }

  async index(): Promise<VaultIndex> {
    return this.vaultIndex;
  }

  /** Serialises disk-touching work so passes never interleave. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch((e) => console.error("[provenance-sync]", e));
    return run;
  }

  connect(name: string, document: Y.Doc): HocuspocusProvider | null {
    if (!this.socket) return null;
    const provider = new HocuspocusProvider({ websocketProvider: this.socket, name, document, token: this.opts.server!.token });
    provider.attach();
    return provider;
  }

  pathOf(id: FileId): string | undefined {
    return this.onDisk.get(id) ?? this.vaultIndex.get(id)?.path;
  }

  private idOnDisk(path: string): FileId | undefined {
    for (const [id, p] of this.onDisk) if (p === path) return id;
    return undefined;
  }

  fileAt(path: string): MarkdownFile | undefined {
    const id = this.idOnDisk(path);
    return id ? this.files.get(id) : undefined;
  }

  async start(): Promise<void> {
    const { opts } = this;
    if (opts.server) {
      this.socket = new HocuspocusProviderWebsocket({
        url: opts.server.url,
        ...(opts.server.WebSocketPolyfill ? { WebSocketPolyfill: opts.server.WebSocketPolyfill } : {}),
      });
      this.socket.on("status", ({ status }: { status: string }) =>
        opts.onStatus?.(status === "connected" ? "connected" : status === "connecting" ? "connecting" : "offline"),
      );
    } else opts.onStatus?.("local-only");

    const indexDoc = this.vaultIndex.doc;
    const name = indexDocName(opts.vault);
    this.indexPersistence = opts.persist?.(name, indexDoc) ?? null;
    await this.indexPersistence?.whenSynced;
    const hadLocal = Y.encodeStateVector(indexDoc).length > 1;
    this.indexProvider = this.connect(name, indexDoc);
    // A fresh device must learn the server's file ids before scanning, or
    // every existing file would be uploaded again under a new id.
    if (!hadLocal && this.indexProvider) await synced(this.indexProvider);

    const lastSeen = ((await this.indexPersistence?.get(MIRROR_KEY)) ?? {}) as Record<string, string>;
    await this.enqueue(() => this.scanDisk(lastSeen));
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
    const unmapped: typeof listed = [];
    for (const file of listed) {
      const remembered = idAt.get(file.path);
      const id = remembered && this.vaultIndex.get(remembered) ? remembered : this.vaultIndex.idOf(file.path);
      if (id && !this.onDisk.has(id)) this.onDisk.set(id, file.path);
      else unmapped.push(file);
    }
    const present = new Set(listed.map((f) => f.path));
    const deleted = Object.entries(lastSeen)
      .filter(([id, path]) => !present.has(path) && !this.onDisk.has(id as FileId) && this.vaultIndex.get(id as FileId))
      .map(([id]) => id as FileId);
    if (deleted.length) {
      this.vaultIndex.doc.transact(() => deleted.forEach((id) => this.vaultIndex.delete(id)), FROM_DISK);
    }

    for (const { path, binary } of unmapped) {
      await (binary ? this.uploadBinary(path, undefined) : this.createFromDisk(path, (await this.opts.disk.read(path)) ?? "", false));
    }
    for (const { path, binary } of listed) {
      const id = binary ? this.idOnDisk(path) : undefined;
      const data = id ? await this.opts.disk.readBinary(path) : null;
      if (id && data) this.binaryHashes.set(id, await sha256(data));
    }
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
      const id = this.idOnDisk(path);
      if (id) seen[id] = path;
    }
    await this.indexPersistence?.set(MIRROR_KEY, seen);
  }

  private scheduleTree() {
    if (this.treeTimer) return;
    this.treeTimer = setTimeout(() => {
      this.treeTimer = null;
      void this.enqueue(() => this.syncTree());
    }, 50);
  }

  /** Moves the disk toward the index: renames, deletions, new files, changed attachments. */
  private async syncTree(): Promise<void> {
    const index = this.vaultIndex;
    const conflicts = index.conflicts();
    if (conflicts.length) {
      index.doc.transact(() => {
        for (const [id, entry] of conflicts) index.rename(id, conflictPath(entry.path, id));
      });
    }
    const entries = new Map(index.entries());

    for (const [id, path] of [...this.onDisk]) {
      if (entries.has(id)) continue;
      this.onDisk.delete(id);
      this.files.get(id)?.destroy();
      this.files.delete(id);
      this.binaryHashes.delete(id);
      await this.opts.disk.trash(path);
    }
    for (const [id, entry] of entries) {
      if (!this.opts.disk.accepts(entry.path)) continue;
      const current = this.onDisk.get(id);
      if (current !== undefined && current !== entry.path) {
        if (this.idOnDisk(entry.path)) continue;
        this.onDisk.set(id, entry.path);
        await this.opts.disk.rename(current, entry.path);
      }
      if (entry.type === "markdown") {
        if (!this.files.has(id) || current === undefined) {
          this.onDisk.set(id, entry.path);
          const file = this.openFile(id, false);
          void file.ready.then(() => this.enqueue(() => file.reconcileDisk()));
        }
      } else await this.syncBinary(id, entry);
    }
    this.saveMirror();
  }

  private openFile(id: FileId, createdHere: boolean): MarkdownFile {
    let file = this.files.get(id);
    if (!file) {
      file = new MarkdownFile(id, this, createdHere);
      this.files.set(id, file);
    }
    return file;
  }

  private async syncBinary(id: FileId, entry: Extract<FileEntry, { type: "binary" }>) {
    if (this.binaryHashes.get(id) === entry.hash || !this.opts.server) return;
    const data = await this.opts.server.blobs.get(entry.hash);
    this.onDisk.set(id, entry.path);
    this.binaryHashes.set(id, entry.hash);
    await this.opts.disk.writeBinary(entry.path, data);
  }

  async createFromDisk(path: string, text: string, alsoWrite: boolean): Promise<MarkdownFile> {
    const id = newFileId();
    this.onDisk.set(id, path);
    const file = this.openFile(id, true);
    file.applyDisk(text);
    this.vaultIndex.doc.transact(() => this.vaultIndex.set(id, { type: "markdown", path }), FROM_DISK);
    if (alsoWrite) await this.opts.disk.write(path, text);
    return file;
  }

  private async uploadBinary(path: string, known: FileId | undefined): Promise<void> {
    if (!this.opts.server) return;
    const data = await this.opts.disk.readBinary(path);
    if (!data) return;
    const hash = await sha256(data);
    const id = known ?? newFileId();
    if (this.binaryHashes.get(id) === hash) return;
    this.onDisk.set(id, path);
    this.binaryHashes.set(id, hash);
    await this.opts.server.blobs.put(hash, data);
    const entry: FileEntry = { type: "binary", path, hash, size: data.byteLength, mtime: Date.now() };
    this.vaultIndex.doc.transact(() => this.vaultIndex.set(id, entry), FROM_DISK);
  }

  // Vault events from the host. Each is a no-op when it is the echo of our own disk operation.

  onCreate(path: string, binary: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (!this.started || this.idOnDisk(path)) return;
      if (binary) return this.uploadBinary(path, undefined);
      await this.createFromDisk(path, (await this.opts.disk.read(path)) ?? "", false);
      this.saveMirror();
    });
  }

  onModify(path: string, binary: boolean): Promise<void> {
    return this.enqueue(async () => {
      const id = this.idOnDisk(path);
      if (!this.started || !id) return;
      if (binary) return this.uploadBinary(path, id);
      await this.files.get(id)?.onDiskModified();
    });
  }

  onRename(from: string, to: string): Promise<void> {
    return this.enqueue(async () => {
      const id = this.idOnDisk(from);
      if (!this.started || !id) return;
      this.onDisk.set(id, to);
      this.vaultIndex.doc.transact(() => this.vaultIndex.rename(id, to), FROM_DISK);
      this.saveMirror();
    });
  }

  onDelete(path: string): Promise<void> {
    return this.enqueue(async () => {
      const id = this.idOnDisk(path);
      if (!this.started || !id) return;
      this.onDisk.delete(id);
      this.files.get(id)?.destroy();
      this.files.delete(id);
      this.binaryHashes.delete(id);
      this.vaultIndex.doc.transact(() => this.vaultIndex.delete(id), FROM_DISK);
      this.saveMirror();
    });
  }

  // VaultDocs, for agent edits arriving through the bridge.

  async updateIndex(fn: (index: VaultIndex) => void): Promise<void> {
    this.vaultIndex.doc.transact(() => fn(this.vaultIndex));
    await this.enqueue(() => this.syncTree());
  }

  async readText(id: FileId): Promise<Y.Text> {
    const file = this.openFile(id, false);
    await file.ready;
    return file.ytext;
  }

  async updateText<T>(id: FileId, fn: (ytext: Y.Text) => T): Promise<T> {
    // An id the index doesn't know yet is a file an agent is creating right now.
    const file = this.openFile(id, !this.vaultIndex.get(id));
    await file.ready;
    let out!: T;
    file.doc.transact(() => (out = fn(file.ytext)));
    return out;
  }

  /**
   * Resolves once queued disk work and pending writes are done; for tests and
   * shutdown. Files still waiting for the server (offline, fresh device) are
   * not waited for longer than `wait` ms.
   */
  async settle(wait = 3000): Promise<void> {
    if (this.treeTimer) {
      clearTimeout(this.treeTimer);
      this.treeTimer = null;
      await this.enqueue(() => this.syncTree());
    }
    await Promise.race([Promise.allSettled([...this.files.values()].map((f) => f.ready)), new Promise((r) => setTimeout(r, wait))]);
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
    for (const f of this.files.values()) f.destroy();
    this.files.clear();
    this.indexProvider?.destroy();
    this.indexPersistence?.destroy();
    this.socket?.destroy();
  }
}
