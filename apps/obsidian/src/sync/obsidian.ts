import { normalizePath, requestUrl, TFile, type App, type Plugin, type TAbstractFile } from "obsidian";
import { IndexeddbPersistence } from "y-indexeddb";
import type * as Y from "yjs";
import { communityPluginOn, corePluginOn, deviceVaultId, replaceIfHolds, wrapEditorSaves } from "../quirks";
import type { Blobs, Disk, Persistence, SyncEngine } from "./engine";

const isBinary = (file: TFile) => file.extension !== "md";

/** Whether a path belongs to the synced vault. The config folder's name is user-configurable, so ask Obsidian for it. */
export function isSyncedPath(app: App, path: string): boolean {
  return !path.startsWith(`${app.vault.configDir}/`);
}

/**
 * Other tools that sync this vault's files. Each turns this plugin's renames,
 * trashes and writes on one device into file events on the others, which
 * this plugin takes for the user's own and syncs again, so one mistake
 * reaches every device.
 */
export function otherSyncs(app: App): string[] {
  const found: string[] = [];
  if (corePluginOn(app, "sync")) found.push("Obsidian Sync");
  if (communityPluginOn(app, "remotely-save")) found.push("Remotely Save");
  if (communityPluginOn(app, "obsidian-git")) found.push("Obsidian Git");
  return found;
}

/** Feeds the vault's events and the editors' saves to whichever engine is running. */
export function watchVault(plugin: Plugin, engine: () => SyncEngine | null) {
  const { app } = plugin;
  const forward = (fn: (engine: SyncEngine, file: TFile) => unknown) => (file: TAbstractFile) => {
    const running = engine();
    if (running && file instanceof TFile && isSyncedPath(app, file.path)) void fn(running, file);
  };
  plugin.registerEvent(app.vault.on("create", forward((e, f) => e.onCreate(f.path, isBinary(f)))));
  plugin.registerEvent(app.vault.on("modify", forward((e, f) => e.onModify(f.path, isBinary(f)))));
  plugin.registerEvent(app.vault.on("delete", forward((e, f) => e.onDelete(f.path))));
  plugin.registerEvent(
    app.vault.on("rename", (file, oldPath) => {
      const running = engine();
      if (running && file instanceof TFile && isSyncedPath(app, oldPath)) void running.onRename(oldPath, file.path);
    }),
  );
  // An editor saves through vault.modify with the exact text it writes;
  // the engine needs that text to tell the save from other programs' edits.
  plugin.register(
    wrapEditorSaves(app, (file, data, write) => {
      const running = engine();
      return running && isSyncedPath(app, file.path) && !isBinary(file) ? running.trackWrite(file.path, data, write) : write();
    }),
  );
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
      .map((f) => ({ path: f.path, binary: isBinary(f) }));
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

export function indexedDbPersistence(app: App) {
  const prefix = `provenance-sync/${deviceVaultId(app)}`;
  return (name: string, doc: Y.Doc): Persistence => new IndexeddbPersistence(`${prefix}/${name}`, doc);
}
