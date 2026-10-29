import { humanId } from "@provenance/core";
import { MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile, type App } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { around } from "monkey-around";
import { startBridge } from "./bridge";
import { ConflictsModal } from "./conflicts";
import { EVENT_LOG_VIEW, EventLog, EventLogView } from "./event-log";
import { installMcpCli, localMcpCommand, type LocalMcpCommand } from "./mcp-cli";
import { provenanceExtension, renderProvenance, segmentAt } from "./editor/binding";
import { defaultSettings, ProvenanceSettingTab, type ProvenanceSettings } from "./settings";
import { SyncEngine, type SyncStatus } from "./sync/engine";
import { httpBlobs, indexedDbPersistence, ObsidianDisk } from "./sync/obsidian";

const CHECK_EVERY = 10 * 60_000;
const OTHER_SYNC_CHECK_EVERY = 5_000;
const LEGACY_TOKEN_SECRET = "provenance-sync-device-token";

type Status = SyncStatus | "error" | "disabled";

const STATUS_TEXT: Record<Status, string> = {
  disabled: "Provenance: off (another sync is on)",
  connected: "Provenance: synced",
  connecting: "Provenance: connecting",
  offline: "Provenance: offline",
  "local-only": "Provenance: local only",
  error: "Provenance: error",
};

/**
 * Other tools that sync this vault's files. Each turns this plugin's renames,
 * trashes and writes on one device into file events on the others, which
 * this plugin takes for the user's own and syncs again, so one mistake
 * reaches every device. These are Obsidian internals, read defensively.
 */
function otherSyncs(app: App): string[] {
  const internal = (app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): unknown } }).internalPlugins;
  const community = (app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins;
  const found: string[] = [];
  if (internal?.getEnabledPluginById?.("sync")) found.push("Obsidian Sync");
  if (community?.has("remotely-save")) found.push("Remotely Save");
  if (community?.has("obsidian-git")) found.push("Obsidian Git");
  return found;
}

function cmOf(view: MarkdownView): EditorView | null {
  return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
}

export default class ProvenancePlugin extends Plugin {
  declare settings: ProvenanceSettings;
  private engine: SyncEngine | null = null;
  private disk: ObsidianDisk | null = null;
  private stopBridge: (() => Promise<void>) | null = null;
  private statusEl: HTMLElement | null = null;
  private status: Status = "connecting";
  /** The other sync tools that kept sync off at the last start, joined; "" if none. */
  private blockedBy = "";
  private mcpCliPath: string | null = null;
  /** Restarts run one after another, so two quick reconnects never leave two engines running. */
  private restarting: Promise<void> = Promise.resolve();
  readonly log = new EventLog();

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
    if (!Platform.isMobile) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass("mod-clickable");
      this.statusEl.onclick = () => void this.openLog();
    }
    this.registerView(EVENT_LOG_VIEW, (leaf) => new EventLogView(leaf, this));
    this.addRibbonIcon("activity", "Open sync event log", () => void this.openLog());
    this.addCommand({ id: "open-event-log", name: "Open sync event log", callback: () => void this.openLog() });
    this.addCommand({ id: "resolve-conflicts", name: "Resolve conflict copies", callback: () => this.resolveConflicts() });
    this.addCommand({ id: "check-sync", name: "Check that every file is synced", callback: () => void this.checkSync() });
    // Vault events can be missed (a restart mid-change, another program), so compare everything now and then.
    this.registerInterval(window.setInterval(() => void this.engine?.check(), CHECK_EVERY));

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
    this.addCommand({ id: "reconnect", name: "Reconnect sync", callback: () => void this.reconnect() });

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
      // Another sync may be turned on or off at any time; Obsidian has no event for it.
      this.registerInterval(
        window.setInterval(() => {
          if (otherSyncs(this.app).join(", ") !== this.blockedBy) void this.restartSync();
        }, OTHER_SYNC_CHECK_EVERY),
      );
      if (Platform.isDesktopApp) {
        installMcpCli(this.app, this.manifest.dir!)
          .then((path) => (this.mcpCliPath = path))
          .catch((e: unknown) => console.error("[provenance-sync] could not install the MCP server", e));
      }
    });
  }

  onunload() {
    void this.restarting.then(() => this.stopSync());
  }

  async openLog() {
    await this.app.workspace.ensureSideLeaf(EVENT_LOG_VIEW, "right", { active: true, reveal: true });
  }

  async checkSync() {
    if (!this.engine) return void new Notice("Provenance sync isn't running.");
    let problems;
    try {
      problems = await this.engine.check();
    } catch (e) {
      return void new Notice(`Sync check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    new Notice(problems ? `Sync check found ${problems} problems and repaired what it could. The sync event log has the details.` : "Sync check: every file matches the index.");
  }

  resolveConflicts() {
    new ConflictsModal(this.app, (path) => new ObsidianDisk(this.app).accepts(path), () => this.engine).open();
  }

  /** What the event log view shows above the events, so the user can check the settings in effect. */
  syncSummary(): Array<[string, string]> {
    const s = this.settings;
    const token = s.tokenSecret ? this.app.secretStorage.getSecret(s.tokenSecret) : null;
    return [
      ["Status", STATUS_TEXT[this.status].replace("Provenance: ", "")],
      ["Server", s.serverUrl || "none (this device only)"],
      ["Device token", token ? "set" : "missing"],
      ["Vault ID", s.vaultId],
      ["Device", s.deviceName],
      ["Author", `human:${s.humanName}`],
      ["Files tracked", this.engine ? String(this.engine.vaultIndex.entries().length) : "sync not running"],
    ];
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

  private setStatus(status: Status) {
    this.status = status;
    this.statusEl?.setText(STATUS_TEXT[status]);
    this.log.changed();
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

  /** Restart that tells the user what came of it, for the Reconnect actions. */
  async reconnect() {
    new Notice("Provenance sync: reconnecting…");
    await this.restartSync();
    new Notice(`${STATUS_TEXT[this.status]}. The sync event log has the details.`);
  }

  restartSync(): Promise<void> {
    const run = this.restarting.then(() => this.startSync());
    this.restarting = run.catch(() => undefined);
    return run;
  }

  private async startSync() {
    await this.stopSync();
    const others = otherSyncs(this.app);
    this.blockedBy = others.join(", ");
    if (others.length) {
      const message = `Sync is off while ${this.blockedBy} also syncs this vault: two sync tools moving the same files can delete notes on every device. Disable ${others.length > 1 ? "them" : "it"} and sync starts again.`;
      this.log.add({ level: "error", message });
      new Notice(`Provenance: ${message}`, 0);
      return this.setStatus("disabled");
    }
    const s = this.settings;
    let author;
    try {
      author = humanId(s.humanName);
    } catch {
      const message = "Your name may only contain letters, digits, '.', '@', '_' and '-'.";
      this.log.add({ level: "error", message });
      new Notice(`Provenance sync: ${message}`);
      return this.setStatus("error");
    }
    const base = s.serverUrl.replace(/\/+$/, "");
    const token = s.tokenSecret ? this.app.secretStorage.getSecret(s.tokenSecret) : null;
    if (base && !token) this.log.add({ level: "warn", message: "A server is set but there is no device token, so sync stays on this device." });
    this.log.add({ level: "info", message: `Starting sync of vault "${s.vaultId}" as ${s.deviceName}${base && token ? ` with ${base}` : ", this device only"}` });
    this.disk = new ObsidianDisk(this.app);
    const appId = (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
    const engine = new SyncEngine({
      vault: s.vaultId,
      author,
      device: s.deviceName,
      disk: this.disk,
      persist: indexedDbPersistence(`provenance-sync/${appId}`),
      onStatus: (status) => this.setStatus(status),
      onEvent: (event) => this.log.add(event),
      ...(base && token
        ? { server: { url: base.replace(/^http/, "ws"), token, blobs: httpBlobs(base, s.vaultId, token) } }
        : {}),
    });
    this.engine = engine;
    try {
      await engine.start();
    } catch (e) {
      console.error("[provenance-sync] start failed", e);
      const message = `Sync failed to start: ${e instanceof Error ? e.message : String(e)}`;
      this.log.add({ level: "error", message });
      new Notice(`Provenance ${message}`);
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
