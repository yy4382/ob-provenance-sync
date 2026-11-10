import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { createApp } from "../../server/src/app";
import { parseConfig } from "../../server/src/config";
import { ChangeSet, Text } from "@codemirror/state";
import { diffChanges, EditLog } from "../src/editor/edit-log";
import { SyncEngine, type Blobs, type Disk, type MarkdownFile, type PaneLog, type Persistence, type TextState } from "../src/sync/engine";

export const TOKEN = "device-token-0123456789";

export async function startServer(options: { historyDays?: number } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "prov-engine-"));
  const app = createApp(parseConfig({ host: "127.0.0.1", port: 0, dataDir, tokens: [{ role: "device", name: "d", token: TOKEN }], ...options }));
  const server = await app.listen();
  const http = `http://127.0.0.1:${server.address.port}`;
  const blobs = (vault: string): Blobs => ({
    put: async (hash, data) => {
      await fetch(`${http}/api/vaults/${vault}/blobs/${hash}`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: data });
    },
    get: async (hash) => (await fetch(`${http}/api/vaults/${vault}/blobs/${hash}`, { headers: { authorization: `Bearer ${TOKEN}` } })).arrayBuffer(),
  });
  return { app, http, ws: http.replace("http", "ws"), blobs };
}

/** A vault folder in memory that reports changes the way Obsidian's vault events do. */
export class MemoryDisk implements Disk {
  readonly files = new Map<string, string | ArrayBuffer>();
  readonly trashed: string[] = [];
  engine: SyncEngine | null = null;

  async list() {
    return [...this.files].map(([path, v]) => ({ path, binary: typeof v !== "string" }));
  }
  /** Simulated latency of disk reads, to widen race windows. */
  readDelay = 0;

  accepts(path: string) {
    return !path.startsWith(".obsidian/");
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async read(path: string) {
    const v = this.files.get(path);
    if (this.readDelay) await new Promise((r) => setTimeout(r, this.readDelay));
    return typeof v === "string" ? v : null;
  }
  async readBinary(path: string) {
    const v = this.files.get(path);
    return v instanceof ArrayBuffer ? v : null;
  }
  async write(path: string, text: string) {
    const existed = this.files.has(path);
    this.files.set(path, text);
    void (existed ? this.engine?.onModify(path, false) : this.engine?.onCreate(path, false));
  }
  async writeIfUnchanged(path: string, expected: string, text: string) {
    if (this.files.get(path) !== expected) return false;
    await this.write(path, text);
    return true;
  }
  /**
   * An editor's save, or with `local` another plugin's or a task click's write, as wrapVaultWrites
   * reports them. `state` is the state the saving editor knows it shows (ProvenanceView.saving).
   */
  save(path: string, text: string, local = false, state?: TextState) {
    if (local) {
      const before = this.files.get(path);
      this.engine?.wroteLocally(path, typeof before === "string" ? before : "", text);
      return this.write(path, text);
    }
    return this.engine!.trackWrite(path, text, () => this.write(path, text), state);
  }
  async writeBinary(path: string, data: ArrayBuffer) {
    const existed = this.files.has(path);
    this.files.set(path, data);
    void (existed ? this.engine?.onModify(path, true) : this.engine?.onCreate(path, true));
  }
  async rename(from: string, to: string) {
    if (!this.files.has(from)) return;
    // Like Obsidian's vault.rename.
    if (this.files.has(to)) throw new Error("Destination file already exists!");
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
    void this.engine?.onRename(from, to);
  }
  async trash(path: string) {
    this.files.delete(path);
    this.trashed.push(path);
    void this.engine?.onDelete(path);
  }
}

/** Stands in for IndexedDB: survives engine restarts within one test. */
export class MemoryStore {
  private readonly updates = new Map<string, Uint8Array[]>();
  private readonly meta = new Map<string, unknown>();
  persist = (name: string, doc: Y.Doc): Persistence => {
    const list = this.updates.get(name) ?? [];
    this.updates.set(name, list);
    for (const u of list) Y.applyUpdate(doc, u);
    const onUpdate = (u: Uint8Array) => list.push(u);
    doc.on("update", onUpdate);
    return {
      whenSynced: Promise.resolve(),
      destroy: () => doc.off("update", onUpdate),
      get: async (key) => this.meta.get(`${name}:${key}`),
      set: async (key, value) => void this.meta.set(`${name}:${key}`, value),
    };
  };
  unsentWeeks = async (vault: string) => (this.meta.get(`${vault}/index:unsent-weeks`) ?? []) as number[];
  stored = {
    names: async () => [...this.updates.keys()],
    drop: async (name: string) => void this.updates.delete(name),
  };
  /** Whether anything was ever written for a document. */
  holds = (name: string) => (this.updates.get(name)?.length ?? 0) > 0;
}

export async function eventually(check: () => void | Promise<void>, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 30));
    }
  }
}

/**
 * An editor that isn't bound to its note, keeping its own edits the way binding.ts does:
 * `doc` is what it shows, and its log holds its edits since a text it was made from.
 */
export class Pane {
  private log: EditLog;

  constructor(
    public doc: string,
    state: TextState | null = null,
  ) {
    this.log = new EditLog(doc, state);
  }

  private change(changes: ChangeSet, own: boolean) {
    const after = changes.apply(Text.of(this.doc.split("\n"))).toString();
    const log = own ? this.log.add(changes) : this.log.rebase(changes, after);
    if (!log) throw new Error("the edits over the changed text don't make the editor's text");
    this.log = log;
    this.doc = after;
  }

  /** The user types `text` at `at`, the end by default. */
  type(text: string, at = this.doc.length) {
    this.change(ChangeSet.of({ from: at, insert: text }, this.doc.length), true);
  }

  /** The user deletes `from`-`to`. */
  delete(from: number, to: number) {
    this.change(ChangeSet.of({ from, to }, this.doc.length), true);
  }

  /** Obsidian puts `text` in the editor, keeping the user's edits: a reload, or a copy from another pane. */
  reload(text: string) {
    this.change(ChangeSet.of(diffChanges(this.doc, text), this.doc.length), false);
  }

  /** What bindEditor takes from this editor. */
  take = () => ({ own: [this.paneLog()], others: [] });

  private paneLog(): PaneLog {
    const log = this.log;
    return {
      text: log.text,
      state: log.state,
      edits: (onto) => log.edits(onto),
      placed: (state) => {
        if (this.log === log) this.log = new EditLog(this.doc, state.text === this.doc ? state : null);
      },
    };
  }

  /** Obsidian picks this editor's text to save: its edits are applied, and the state it shows comes back, as in ProvenanceView.saving. */
  saving(file: MarkdownFile): TextState | undefined {
    if (file.placeEdits([this.paneLog()], "save").length) this.log = new EditLog(this.doc);
    return this.log.state?.text === this.doc ? this.log.state : undefined;
  }
}
