import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type ProvenancePlugin from "./main";
import type { SyncEvent } from "./sync/engine";

export interface LoggedEvent extends SyncEvent {
  at: number;
  /** How many times in a row this same event happened. */
  count: number;
}

/** Per-file steps make up most entries, so a startup or a conflict cleanup fits several times over. */
const LIMIT = 5000;
/** The view draws only the newest entries; "Copy log" has them all. */
const SHOWN = 300;

/** The last few thousand sync events, kept in memory for the event log view. */
export class EventLog {
  readonly entries: LoggedEvent[] = [];
  private readonly listeners = new Set<() => void>();

  add(event: SyncEvent): void {
    const last = this.entries.at(-1);
    if (last && last.level === event.level && last.message === event.message && last.path === event.path) {
      last.count++;
      last.at = Date.now();
    } else {
      this.entries.push({ ...event, at: Date.now(), count: 1 });
      if (this.entries.length > LIMIT) this.entries.shift();
    }
    this.changed();
  }

  clear(): void {
    this.entries.length = 0;
    this.changed();
  }

  /** Tells open views to redraw, also when the sync status changed. */
  changed(): void {
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  toText(): string {
    return this.entries
      .map((e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase()} ${e.message}${e.path ? ` [${e.path}]` : ""}${e.count > 1 ? ` (x${e.count})` : ""}`)
      .join("\n");
  }
}

export const EVENT_LOG_VIEW = "provenance-event-log";

export class EventLogView extends ItemView {
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ProvenancePlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return EVENT_LOG_VIEW;
  }

  getDisplayText() {
    return "Sync event log";
  }

  getIcon() {
    return "activity";
  }

  async onOpen() {
    this.unsubscribe = this.plugin.log.subscribe(() => this.render());
    this.render();
  }

  async onClose() {
    this.unsubscribe?.();
  }

  private render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("prov-log");

    const summary = root.createDiv({ cls: "prov-log-summary" });
    for (const [label, value] of this.plugin.syncSummary()) {
      const row = summary.createDiv({ cls: "prov-log-row" });
      row.createSpan({ cls: "prov-log-label", text: label });
      row.createSpan({ text: value });
    }

    const actions = root.createDiv({ cls: "prov-log-actions" });
    const button = (icon: string, text: string, onClick: () => void) => {
      const b = actions.createEl("button", { text });
      setIcon(b.createSpan({ prepend: true }), icon);
      b.onclick = onClick;
    };
    button("refresh-cw", "Reconnect", () => void this.plugin.restartSync());
    button("list-checks", "Check sync", () => void this.plugin.checkSync());
    button("git-merge", "Resolve conflicts", () => void this.plugin.resolveConflicts());
    button("copy", "Copy log", () => {
      void navigator.clipboard.writeText(this.plugin.log.toText()).then(() => new Notice("Sync event log copied."));
    });
    button("trash-2", "Clear", () => this.plugin.log.clear());

    const list = root.createDiv({ cls: "prov-log-list" });
    const entries = this.plugin.log.entries;
    if (!entries.length) list.createDiv({ cls: "prov-log-empty", text: "Nothing has happened yet." });
    for (const e of entries.slice(-SHOWN).reverse()) {
      const item = list.createDiv({ cls: `prov-log-item prov-log-${e.level}` });
      const meta = item.createDiv({ cls: "prov-log-meta" });
      meta.createSpan({ text: new Date(e.at).toLocaleTimeString() });
      if (e.count > 1) meta.createSpan({ cls: "prov-log-count", text: `x${e.count}` });
      item.createDiv({ text: e.message });
      if (e.path) {
        const path = e.path;
        const link = item.createEl("a", { cls: "prov-log-path", text: path });
        link.onclick = () => void this.app.workspace.openLinkText(path, "");
      }
    }
    if (entries.length > SHOWN) list.createDiv({ cls: "prov-log-empty", text: `${entries.length - SHOWN} older events are left out here; "Copy log" includes them.` });
  }
}
