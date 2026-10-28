import { humanId } from "@provenance/core";
import { MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { startBridge } from "./bridge";
import { provenanceExtension, renderProvenance, segmentAt } from "./editor/binding";
import { defaultSettings, ProvenanceSettingTab, type ProvenanceSettings } from "./settings";
import { SyncEngine, type SyncStatus } from "./sync/engine";
import { httpBlobs, indexedDbPersistence, ObsidianDisk } from "./sync/obsidian";

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

  async onload() {
    this.settings = { ...defaultSettings(this.app), ...((await this.loadData()) as Partial<ProvenanceSettings> | null) };
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
      void this.restartSync();
    });
  }

  onunload() {
    void this.stopSync();
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
    this.disk = new ObsidianDisk(this.app);
    const appId = (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
    const engine = new SyncEngine({
      vault: s.vaultId,
      author,
      device: s.deviceName,
      disk: this.disk,
      persist: indexedDbPersistence(`provenance-sync/${appId}`),
      onStatus: (status) => this.setStatus(status),
      ...(base && s.token
        ? { server: { url: base.replace(/^http/, "ws"), token: s.token, blobs: httpBlobs(base, s.vaultId, s.token) } }
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
