import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { createApp } from "../../server/src/app";
import { parseConfig } from "../../server/src/config";
import { SyncEngine, type Blobs, type Disk, type Persistence } from "../src/sync/engine";

export const TOKEN = "device-token-0123456789";

export async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), "prov-engine-"));
  const app = createApp(parseConfig({ host: "127.0.0.1", port: 0, dataDir, tokens: [{ role: "device", name: "d", token: TOKEN }] }));
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
  async writeBinary(path: string, data: ArrayBuffer) {
    const existed = this.files.has(path);
    this.files.set(path, data);
    void (existed ? this.engine?.onModify(path, true) : this.engine?.onCreate(path, true));
  }
  async rename(from: string, to: string) {
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
