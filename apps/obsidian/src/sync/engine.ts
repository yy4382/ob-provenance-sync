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

export interface Persistence {
  whenSynced: Promise<unknown>;
  destroy(): unknown;
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

const ECHO_WINDOW = 20;

export async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One markdown file's CRDT replica. Disk writes are debounced and skipped
 * while an editor is bound, because then the editor owns saving. `recent`
 * remembers what we last put on disk so the modify events our own writes
 * cause are recognised as echoes instead of external edits.
 */
export class MarkdownFile {
  readonly doc = new Y.Doc({ gc: false });
  readonly ytext = this.doc.getText(TEXT_KEY);
  readonly ready: Promise<void>;
  private readonly recent: string[] = [];
  private editors = 0;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private provider: HocuspocusProvider | null = null;
  private persistence: Persistence | null = null;
  private hadLocal = false;

  constructor(
    readonly id: FileId,
    private readonly engine: SyncEngine,
  ) {
    this.ytext.observe((_e, tr) => {
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
    this.hadLocal = Y.encodeStateVector(this.doc).length > 1;
    this.provider = this.engine.connect(name, this.doc);
    if (!this.hadLocal && this.provider) await synced(this.provider);
  }

  /**
   * With local history, whatever differs on disk happened while we weren't
   * watching, so it goes in as an unknown edit and the CRDT merges it with
   * remote changes. Without local history (a fresh device) the server's copy
   * wins and a differing local file is kept as a conflict copy.
   */
  async reconcileDisk(): Promise<void> {
    const path = this.path;
    if (path === undefined) return;
    const disk = await this.engine.opts.disk.read(path);
    const text = this.ytext.toJSON();
    if (disk === null || disk === text) {
      if (disk === null) await this.writeNow();
      return;
    }
    if (this.hadLocal || text === "") {
      this.applyFromDisk(disk);
      return;
    }
    await this.engine.createFromDisk(conflictPath(path, this.id), disk, true);
    await this.writeNow();
  }

  applyFromDisk(text: string): void {
    this.remember(text);
    this.doc.transact(() => setText(this.ytext, text, unknownProvenance(this.engine.opts.device)), FROM_DISK);
  }

  /** An edit an external program made to this file. Echoes of our own writes are ignored. */
  async onDiskModified(): Promise<void> {
    if (this.editors > 0 || !this.path) return;
    const disk = await this.engine.opts.disk.read(this.path);
    if (disk === null) return;
    if (this.recent.includes(disk)) {
      if (disk !== this.ytext.toJSON()) this.scheduleWrite();
      return;
    }
    this.applyFromDisk(disk);
  }

  /** Returns a release function. While any editor is bound, the editor saves the file. */
  bindEditor(): () => void {
    this.editors++;
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

  private remember(text: string) {
    this.recent.push(text);
    if (this.recent.length > ECHO_WINDOW) this.recent.shift();
  }

  private scheduleWrite() {
    if (this.editors > 0) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.engine.enqueue(() => this.writeNow());
    }, 200);
  }

  async writeNow(): Promise<void> {
    const path = this.path;
    if (path === undefined || this.editors > 0) return;
    const text = this.ytext.toJSON();
    if (this.recent.at(-1) === text) return;
    this.remember(text);
    await this.engine.opts.disk.write(path, text);
  }

  async flush(): Promise<void> {
    if (!this.writeTimer) return;
    clearTimeout(this.writeTimer);
    this.writeTimer = null;
    await this.writeNow();
  }

  destroy(): void {
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
 * idempotent pass that moves the disk toward the index.
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

    await this.enqueue(() => this.scanDisk());
    this.vaultIndex.files.observe((_e, tr) => {
      if (tr.origin !== FROM_DISK) this.scheduleTree();
    });
    this.started = true;
    await this.enqueue(() => this.syncTree());
  }

  private async scanDisk(): Promise<void> {
    for (const { path, binary } of await this.opts.disk.list()) {
      const id = this.vaultIndex.idOf(path);
      if (!id) {
        await (binary ? this.uploadBinary(path, undefined) : this.createFromDisk(path, (await this.opts.disk.read(path)) ?? "", false));
        continue;
      }
      this.onDisk.set(id, path);
      if (binary) {
        const data = await this.opts.disk.readBinary(path);
        if (data) this.binaryHashes.set(id, await sha256(data));
      }
    }
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
      const current = this.onDisk.get(id);
      if (current !== undefined && current !== entry.path) {
        if (this.idOnDisk(entry.path)) continue;
        this.onDisk.set(id, entry.path);
        await this.opts.disk.rename(current, entry.path);
      }
      if (entry.type === "markdown") {
        if (!this.files.has(id) || current === undefined) {
          this.onDisk.set(id, entry.path);
          const file = this.openFile(id);
          void file.ready.then(() => this.enqueue(() => file.reconcileDisk()));
        }
      } else await this.syncBinary(id, entry);
    }
  }

  private openFile(id: FileId): MarkdownFile {
    let file = this.files.get(id);
    if (!file) {
      file = new MarkdownFile(id, this);
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
    const file = this.openFile(id);
    file.applyFromDisk(text);
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
    });
  }

  // VaultDocs, for agent edits arriving through the bridge.

  async updateIndex(fn: (index: VaultIndex) => void): Promise<void> {
    this.vaultIndex.doc.transact(() => fn(this.vaultIndex));
    await this.enqueue(() => this.syncTree());
  }

  async readText(id: FileId): Promise<Y.Text> {
    const file = this.openFile(id);
    await file.ready;
    return file.ytext;
  }

  async updateText<T>(id: FileId, fn: (ytext: Y.Text) => T): Promise<T> {
    const file = this.openFile(id);
    await file.ready;
    let out!: T;
    file.doc.transact(() => (out = fn(file.ytext)));
    return out;
  }

  /** Resolves once queued disk work and pending writes are done; for tests and shutdown. */
  async settle(): Promise<void> {
    if (this.treeTimer) {
      clearTimeout(this.treeTimer);
      this.treeTimer = null;
      await this.enqueue(() => this.syncTree());
    }
    await Promise.all([...this.files.values()].map((f) => f.ready));
    await this.enqueue(async () => {
      for (const f of this.files.values()) await f.flush();
    });
  }

  destroy(): void {
    if (this.treeTimer) clearTimeout(this.treeTimer);
    for (const f of this.files.values()) f.destroy();
    this.files.clear();
    this.indexProvider?.destroy();
    this.indexPersistence?.destroy();
    this.socket?.destroy();
  }
}
