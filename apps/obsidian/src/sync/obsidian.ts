import { normalizePath, requestUrl, TFile, type App } from "obsidian";
import { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";
import { replaceIfHolds } from "../quirks";
import type { Blobs, Disk, Persistence } from "./engine";

/** Whether a path belongs to the synced vault. The config folder's name is user-configurable, so ask Obsidian for it. */
export function isSyncedPath(app: App, path: string): boolean {
  return !path.startsWith(`${app.vault.configDir}/`);
}

/** The vault through Obsidian's API, so every write is seen by open views and other plugins. */
export class ObsidianDisk implements Disk {
  constructor(private readonly app: App) {}

  accepts(path: string): boolean {
    return isSyncedPath(this.app, path);
  }

  private file(path: string): TFile | null {
    return this.app.vault.getFileByPath(normalizePath(path));
  }

  private async ensureParent(path: string) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir && !this.app.vault.getFolderByPath(dir)) await this.app.vault.createFolder(dir);
  }

  async list() {
    return this.app.vault
      .getFiles()
      .filter((f) => this.accepts(f.path))
      .map((f) => ({ path: f.path, binary: f.extension !== "md" }));
  }

  async exists(path: string) {
    return this.file(path) !== null;
  }

  async read(path: string) {
    const f = this.file(path);
    return f ? this.app.vault.read(f) : null;
  }

  async readBinary(path: string) {
    const f = this.file(path);
    return f ? this.app.vault.readBinary(f) : null;
  }

  async write(path: string, text: string) {
    const f = this.file(path);
    if (f) await this.app.vault.modify(f, text);
    else {
      await this.ensureParent(path);
      await this.app.vault.create(path, text);
    }
  }

  async writeIfUnchanged(path: string, expected: string, text: string) {
    const f = this.file(path);
    return f ? replaceIfHolds(this.app, f, expected, text) : false;
  }

  async writeBinary(path: string, data: ArrayBuffer) {
    const f = this.file(path);
    if (f) await this.app.vault.modifyBinary(f, data);
    else {
      await this.ensureParent(path);
      await this.app.vault.createBinary(path, data);
    }
  }

  /** Plain vault rename: the device that started the rename already rewrote links in synced content. */
  async rename(from: string, to: string) {
    const f = this.file(from);
    if (!f) return;
    await this.ensureParent(to);
    await this.app.vault.rename(f, to);
  }

  async trash(path: string) {
    const f = this.file(path);
    if (f) await this.app.fileManager.trashFile(f);
  }
}

export function httpBlobs(baseUrl: string, vault: string, token: string): Blobs {
  const url = (hash: string) => `${baseUrl}/api/vaults/${encodeURIComponent(vault)}/blobs/${hash}`;
  const headers = { authorization: `Bearer ${token}` };
  return {
    async put(hash, data) {
      await requestUrl({ url: url(hash), method: "PUT", body: data, headers, contentType: "application/octet-stream" });
    },
    async get(hash) {
      return (await requestUrl({ url: url(hash), headers })).arrayBuffer;
    },
  };
}

export function indexedDbPersistence(prefix: string) {
  return (name: string, doc: Y.Doc): Persistence => new IndexeddbPersistence(`${prefix}/${name}`, doc);
}
