import { errorMessage, humanId, reattribute, REATTRIBUTABLE } from "@provenance/core";
import { MarkdownView, Notice, Platform, Plugin, type Editor } from "obsidian";
import { installCli, localMcpCommand, registerVault, unregisterVault, type LocalMcpCommand } from "./agent-cli";
import { registerAgentCli } from "./agent-ops";
import { ConflictsModal } from "./conflicts";
import { EVENT_LOG_VIEW, EventLog, EventLogView } from "./event-log";
import { provenanceExtension, renderProvenance, segmentAt } from "./editor/binding";
import { codeMirrorOf } from "./quirks";
import { ReattributeModal, type Attribution, type Reattribution } from "./reattribute";
import { defaultSettings, ProvenanceSettingTab, type ProvenanceSettings } from "./settings";
import { SyncEngine, type SyncStatus } from "./sync/engine";
import { httpBlobs, indexedDbPersistence, isSyncedPath, ObsidianDisk, otherSyncs, watchVault } from "./sync/obsidian";

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

export default class ProvenancePlugin extends Plugin {
  declare settings: ProvenanceSettings;
  private engine: SyncEngine | null = null;
  private statusEl: HTMLElement | null = null;
  private status: Status = "connecting";
  /** The other sync tools that kept sync off at the last start, joined; "" if none. */
  private blockedBy = "";
  private cliPath: string | null = null;
  private agentCliUpdate: Promise<void> = Promise.resolve();
  /** Stopping waits for these: a write that reaches a stopped engine lands in the file with no author. */
  private readonly agentCalls = new Set<Promise<unknown>>();
  /** Restarts run one after another, so two quick reconnects never leave two engines running. */
  private restarting: Promise<void> = Promise.resolve();
  private firstStartDone = () => {};
  /** A CLI call can open this vault's window and arrive before sync has started for the first time. */
  private readonly firstStart = new Promise<void>((resolve) => (this.firstStartDone = resolve));
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
        const cm = ctx instanceof MarkdownView ? codeMirrorOf(ctx) : null;
        const segment = cm ? segmentAt(cm, editor.posToOffset(editor.getCursor())) : null;
        if (!segment) new Notice("No provenance recorded here.");
        else {
          const fragment = createFragment((f) => f.appendChild(renderProvenance(segment)));
          new Notice(fragment, 10_000);
        }
      },
    });
    this.addCommand({
      id: "mark-as-ai",
      name: "Mark selection as written by AI",
      editorCallback: (editor, ctx) => ctx instanceof MarkdownView && this.reattribute(editor, ctx, "mark-as-ai"),
    });
    this.addCommand({
      id: "recover-provenance",
      name: "Recover provenance of unknown text…",
      editorCallback: (editor, ctx) => ctx instanceof MarkdownView && this.reattribute(editor, ctx, "recover"),
    });
    this.addCommand({ id: "reconnect", name: "Reconnect sync", callback: () => void this.reconnect() });
    registerAgentCli(this, async (run) => {
      await this.firstStart;
      // A restart queued during the wait goes first, or this call would start on the engine it's about to stop.
      for (let seen; seen !== this.restarting; ) {
        seen = this.restarting;
        await seen;
      }
      if (!this.engine || !this.settings.agentCli) return null;
      const call = run(this.engine);
      this.agentCalls.add(call);
      try {
        return await call;
      } finally {
        this.agentCalls.delete(call);
      }
    });

    this.app.workspace.onLayoutReady(() => {
      watchVault(this, () => this.engine);
      void this.restartSync().finally(this.firstStartDone);
      // Another sync may be turned on or off at any time; Obsidian has no event for it.
      this.registerInterval(
        window.setInterval(() => {
          if (otherSyncs(this.app).join(", ") !== this.blockedBy) void this.restartSync();
        }, OTHER_SYNC_CHECK_EVERY),
      );
      this.syncAgentCli();
      void this.removeOldAgentFiles();
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
      return void new Notice(`Sync check failed: ${errorMessage(e)}`);
    }
    new Notice(problems ? `Sync check found ${problems} problems and repaired what it could. The sync event log has the details.` : "Sync check: every file matches the index.");
  }

  /** The selection, or the sentence at the cursor, and its note; a message instead if its authors can't be changed now. */
  private reattributionTarget(editor: Editor, view: MarkdownView) {
    if (!this.engine) return "Provenance sync isn't running.";
    const file = view.file && this.engine.fileAt(view.file.path);
    if (!file) return "This note isn't tracked by provenance sync.";
    if (file.ytext.length !== editor.getValue().length) return "This note is still syncing; try again in a moment.";
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    if (from < to) return { file, from, to, where: "the selection" };
    const cm = codeMirrorOf(view);
    const segment = cm && segmentAt(cm, from);
    if (!segment) return "Select some text first.";
    return { file, from: segment.from, to: segment.to, where: "this sentence" };
  }

  private reattribute(editor: Editor, view: MarkdownView, mode: Reattribution) {
    const first = this.reattributionTarget(editor, view);
    if (typeof first === "string") return void new Notice(first);
    new ReattributeModal(this.app, mode, this.engine!.opts.author, this.settings.lastAgentName, (choice: Attribution) => {
      // The note may have changed while the modal was open.
      const target = this.reattributionTarget(editor, view);
      if (typeof target === "string") return void new Notice(target);
      const { file, from, to, where } = target;
      const by = choice.why === "human-typed" ? file.human() : file.agent(choice.agent, choice.why, choice.note);
      let changed = 0;
      file.doc.transact(() => (changed = reattribute(file.ytext, from, to, by, REATTRIBUTABLE[mode])));
      const agentName = choice.why === "human-typed" ? null : choice.agent.slice("agent:".length);
      if (agentName && agentName !== this.settings.lastAgentName) {
        this.settings.lastAgentName = agentName;
        void this.saveSettings();
      }
      const as = choice.why === "human-via-agent" ? `${by.author} (your words)` : by.author;
      if (mode === "mark-as-ai") {
        new Notice(changed ? `Marked ${changed} characters as written by ${as}.` : `Nothing to change: ${where} is already attributed to an agent.`);
      } else {
        new Notice(changed ? `Recovered ${changed} characters as ${as}.` : `No unknown text in ${where}.`);
      }
    }).open();
  }

  resolveConflicts() {
    new ConflictsModal(this.app, (path) => isSyncedPath(this.app, path), () => this.engine).open();
  }

  /** What the event log view shows above the events, so the user can check the settings in effect. */
  syncSummary(): Array<[string, string]> {
    const s = this.settings;
    const { token } = this.serverSettings();
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

  /** What versions before ob-provenance left in the plugin folder. */
  private async removeOldAgentFiles() {
    const { adapter } = this.app.vault;
    for (const name of ["bridge.json", "provenance-mcp.mjs"]) {
      const path = `${this.manifest.dir}/${name}`;
      if (await adapter.exists(path)) await adapter.remove(path);
    }
  }

  /** How an agent on this computer starts the local MCP server for this vault. */
  mcpCommand(): LocalMcpCommand | null {
    return this.cliPath ? localMcpCommand(this.app, this.cliPath) : null;
  }

  /** Brings the installed CLI and this vault's entry in line with the settings. The entry is what lets agents reach this vault. */
  syncAgentCli() {
    if (!Platform.isDesktopApp) return;
    const update = async () => {
      if (!this.settings.agentCli) {
        this.cliPath = null;
        return unregisterVault(this.app);
      }
      this.cliPath = await installCli();
      const { url, token } = this.serverSettings();
      await registerVault(this.app, url && token ? { url, vault: this.settings.vaultId, token } : null);
    };
    // Settings can change faster than files are written, and the last write must reflect the last change.
    this.agentCliUpdate = this.agentCliUpdate.then(update).catch((e: unknown) => {
      this.log.add({ level: "error", message: `Could not update the agent CLI: ${errorMessage(e)}` });
    });
  }

  /** The server URL without a trailing slash ("" if none), and the device token from the keychain. */
  private serverSettings(): { url: string; token: string | null } {
    const s = this.settings;
    return { url: s.serverUrl.replace(/\/+$/, ""), token: s.tokenSecret ? this.app.secretStorage.getSecret(s.tokenSecret) : null };
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
    await Promise.allSettled(this.agentCalls);
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
    const { url: base, token } = this.serverSettings();
    if (base && !token) this.log.add({ level: "warn", message: "A server is set but there is no device token, so sync stays on this device." });
    this.log.add({ level: "info", message: `Starting sync of vault "${s.vaultId}" as ${s.deviceName}${base && token ? ` with ${base}` : ", this device only"}` });
    const engine = new SyncEngine({
      vault: s.vaultId,
      author,
      device: s.deviceName,
      disk: new ObsidianDisk(this.app),
      persist: indexedDbPersistence(this.app),
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
      const message = `Sync failed to start: ${errorMessage(e)}`;
      this.log.add({ level: "error", message });
      new Notice(`Provenance ${message}`);
      return this.setStatus("error");
    }
    if (this.engine !== engine) return;
    this.pokeEditors();
  }

  /** Editors attach to the engine on their next update; give them one. */
  private pokeEditors() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) codeMirrorOf(leaf.view)?.dispatch({});
    });
  }
}
