import { humanId } from "@provenance/core";
import { MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { around } from "monkey-around";
import { startBridge } from "./bridge";
import { installMcpCli, localMcpCommand, type LocalMcpCommand } from "./mcp-cli";
import { provenanceExtension, renderProvenance, segmentAt } from "./editor/binding";
import { defaultSettings, ProvenanceSettingTab, type ProvenanceSettings } from "./settings";
import { SyncEngine, type SyncStatus } from "./sync/engine";
import { httpBlobs, indexedDbPersistence, ObsidianDisk } from "./sync/obsidian";

const LEGACY_TOKEN_SECRET = "provenance-sync-device-token";

const STATUS_TEXT: Record<SyncStatus | "error", string> = {
  connected: "Provenance: synced",
  connecting: "Provenance: connecting",
  offline: "Provenance: offline",
  "local-only": "Provenance: local only",
  error: "Provenance: error",
};

function cmOf(view: MarkdownView): EditorView | null {
  return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
}

export default class ProvenancePlugin extends Plugin {
  declare settings: ProvenanceSettings;
  private engine: SyncEngine | null = null;
  private disk: ObsidianDisk | null = null;
  private stopBridge: (() => Promise<void>) | null = null;
  private statusEl: HTMLElement | null = null;
  private mcpCliPath: string | null = null;

  async onload() {
    const { token: legacyToken, ...saved } = ((await this.loadData()) ?? {}) as Partial<ProvenanceSettings> & { token?: string };
    this.settings = { ...defaultSettings(this.app), ...saved };
    if (legacyToken) {
      // Older versions kept the token in data.json; move it into the keychain.
      this.app.secretStorage.setSecret(LEGACY_TOKEN_SECRET, legacyToken);
      this.settings.tokenSecret = LEGACY_TOKEN_SECRET;
    }
    await this.saveSettings();
    this.addSettingTab(new ProvenanceSettingTab(this.app, this));
    this.registerEditorExtension(provenanceExtension(() => this.engine));
    this.applyColors();
    if (!Platform.isMobile) this.statusEl = this.addStatusBarItem();

    this.addCommand({
      id: "show-provenance-at-cursor",
      name: "Show who wrote the current sentence",
      editorCallback: (editor, ctx) => {
        const cm = ctx instanceof MarkdownView ? cmOf(ctx) : null;
        const segment = cm ? segmentAt(cm, editor.posToOffset(editor.getCursor())) : null;
        if (!segment) new Notice("No provenance recorded here.");
        else {
          const fragment = createFragment((f) => f.appendChild(renderProvenance(segment)));
          new Notice(fragment, 10_000);
        }
      },
    });
    this.addCommand({ id: "reconnect", name: "Reconnect sync", callback: () => void this.restartSync() });

    const forward = (fn: (engine: SyncEngine, file: TFile) => unknown) => (file: TAbstractFile) => {
      if (this.engine && this.disk && file instanceof TFile && this.disk.accepts(file.path)) void fn(this.engine, file);
    };
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", forward((e, f) => e.onCreate(f.path, f.extension !== "md"))));
      this.registerEvent(this.app.vault.on("modify", forward((e, f) => e.onModify(f.path, f.extension !== "md"))));
      this.registerEvent(this.app.vault.on("delete", forward((e, f) => e.onDelete(f.path))));
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (this.engine && this.disk && file instanceof TFile && this.disk.accepts(oldPath)) void this.engine.onRename(oldPath, file.path);
        }),
      );
      // An editor saves through vault.modify with the exact text it writes;
      // the engine needs that text to tell the save from other programs' edits.
      const vault = this.app.vault;
      this.register(
        around(vault, {
          modify: (next) => (file, data, options) => {
            const write = () => next.call(vault, file, data, options);
            const tracked = this.engine && this.disk?.accepts(file.path) && file.extension === "md";
            return tracked ? this.engine!.trackWrite(file.path, data, write) : write();
          },
        }),
      );
      void this.restartSync();
      if (Platform.isDesktopApp) {
        installMcpCli(this.app, this.manifest.dir!)
          .then((path) => (this.mcpCliPath = path))
          .catch((e: unknown) => console.error("[provenance-sync] could not install the MCP server", e));
      }
    });
  }

  onunload() {
    void this.stopSync();
  }

  /** How an agent on this computer starts the local MCP server, with this vault's paths and server filled in. */
  mcpCommand(): LocalMcpCommand | null {
    if (!this.mcpCliPath) return null;
    const s = this.settings;
    const token = s.tokenSecret ? this.app.secretStorage.getSecret(s.tokenSecret) : null;
    const url = s.serverUrl.replace(/\/+$/, "");
    return localMcpCommand(this.app, this.mcpCliPath, url && token ? { url, vault: s.vaultId, token } : null);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  applyColors() {
    document.body.toggleClass("prov-colors", this.settings.showColors);
  }

  private setStatus(status: SyncStatus | "error") {
    this.statusEl?.setText(STATUS_TEXT[status]);
  }

  private async stopSync() {
    await this.stopBridge?.();
    this.stopBridge = null;
    if (this.engine) {
      await this.engine.settle();
      this.engine.destroy();
    }
    this.engine = null;
    this.pokeEditors();
  }

  async restartSync() {
    await this.stopSync();
    const s = this.settings;
    let author;
    try {
      author = humanId(s.humanName);
    } catch {
      new Notice("Provenance sync: your name may only contain letters, digits, '.', '@', '_' and '-'.");
      return this.setStatus("error");
    }
    const base = s.serverUrl.replace(/\/+$/, "");
    const token = s.tokenSecret ? this.app.secretStorage.getSecret(s.tokenSecret) : null;
    this.disk = new ObsidianDisk(this.app);
    const appId = (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
    const engine = new SyncEngine({
      vault: s.vaultId,
      author,
      device: s.deviceName,
      disk: this.disk,
      persist: indexedDbPersistence(`provenance-sync/${appId}`),
      onStatus: (status) => this.setStatus(status),
      ...(base && token
        ? { server: { url: base.replace(/^http/, "ws"), token, blobs: httpBlobs(base, s.vaultId, token) } }
        : {}),
    });
    this.engine = engine;
    try {
      await engine.start();
    } catch (e) {
      console.error("[provenance-sync] start failed", e);
      new Notice(`Provenance sync failed to start: ${e instanceof Error ? e.message : String(e)}`);
      return this.setStatus("error");
    }
    if (this.engine !== engine) return;
    this.pokeEditors();
    if (Platform.isDesktopApp && s.enableBridge) {
      this.stopBridge = await startBridge(this.app, engine, `${this.manifest.dir}/bridge.json`);
    }
  }

  /** Editors attach to the engine on their next update; give them one. */
  private pokeEditors() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) cmOf(leaf.view)?.dispatch({});
    });
  }
}
