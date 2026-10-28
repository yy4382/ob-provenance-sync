import { Annotation, RangeSetBuilder, StateEffect, Transaction, type ChangeSpec, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { attribute, insertText, setText, type Segment } from "@provenance/core";
import { editorInfoField } from "obsidian";
import type * as Y from "yjs";
import type { MarkdownFile, SyncEngine } from "../sync/engine";

const fromYjs = Annotation.define<boolean>();
const refresh = StateEffect.define<null>();

const marks = {
  human: Decoration.mark({ class: "prov-human" }),
  "via-agent": Decoration.mark({ class: "prov-via-agent" }),
  agent: Decoration.mark({ class: "prov-agent" }),
  mixed: Decoration.mark({ class: "prov-mixed" }),
} as const;

/**
 * Obsidian itself mirrors every edit between split panes of one file, as a
 * "set" transaction. So remote changes go into one pane per file (the first,
 * the primary), changes from a sibling pane are never re-applied, and a pane
 * only pushes to the CRDT when its text has actually diverged from it. That
 * way the pane where the edit happened records it, with its real author.
 */
const panes = new Map<MarkdownFile, Set<object>>();

/**
 * Typing, pasting, undo and Obsidian's own editing commands carry a
 * CodeMirror user event and are the human's. Obsidian uses the "set" event
 * both to reload a file another program changed and to mirror an edit into
 * sibling panes; other plugins editing through the Editor API carry none.
 */
function isHumanEdit(tr: Transaction): boolean {
  const event = tr.annotation(Transaction.userEvent);
  return event !== undefined && event !== "set";
}

function deltaToChanges(delta: Y.YTextEvent["delta"]): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let pos = 0;
  for (const op of delta) {
    if (op.retain !== undefined) pos += op.retain;
    else if (typeof op.insert === "string") changes.push({ from: pos, insert: op.insert });
    else if (op.delete !== undefined) {
      changes.push({ from: pos, to: pos + op.delete });
      pos += op.delete;
    }
  }
  return changes;
}

let currentEngine: () => SyncEngine | null = () => null;
const engine = () => currentEngine();

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    segments: Segment[] = [];
    file: MarkdownFile | null = null;
    private path: string | null = null;
    release: (() => void) | null = null;
    private readonly observer = (event: Y.YTextEvent, tr: Y.Transaction) => this.onYjs(event, tr);

    constructor(readonly view: EditorView) {
      this.attach();
    }

    get primary(): boolean {
      return this.file !== null && panes.get(this.file)?.values().next().value === this;
    }

    private currentPath(): string | null {
      return this.view.state.field(editorInfoField, false)?.file?.path ?? null;
    }

    /** Editors are reused when a pane opens another file, so this runs on every update. */
    private attach() {
      const path = this.currentPath();
      const file = path ? (engine()?.fileAt(path) ?? null) : null;
      if (path === this.path && file === this.file) return;
      this.detach();
      this.path = path;
      if (!file) return;
      this.file = file;
      let set = panes.get(file);
      if (!set) panes.set(file, (set = new Set()));
      set.add(this);
      file.ytext.observe(this.observer);
      void file.ready.then(() => {
        if (this.file !== file) return;
        this.release = file.bindEditor();
        if (this.primary) this.loadFromCrdt();
        this.scheduleRefresh();
      });
    }

    private loadFromCrdt() {
      const text = this.file!.ytext.toJSON();
      if (this.view.state.doc.toString() !== text) {
        // The CRDT already absorbed the disk state, so it is the newer copy.
        this.view.dispatch({
          changes: { from: 0, to: this.view.state.doc.length, insert: text },
          annotations: [fromYjs.of(true), Transaction.addToHistory.of(false)],
        });
      }
    }

    private detach() {
      const file = this.file;
      if (!file) return;
      file.ytext.unobserve(this.observer);
      const wasPrimary = this.primary;
      const set = panes.get(file)!;
      set.delete(this);
      this.release?.();
      this.release = null;
      this.file = null;
      this.segments = [];
      this.decorations = Decoration.none;
      if (set.size === 0) panes.delete(file);
      else if (wasPrimary) {
        const next = set.values().next().value as { release: unknown; loadFromCrdt(): void };
        if (next.release) next.loadFromCrdt();
      }
    }

    private onYjs(event: Y.YTextEvent, tr: Y.Transaction) {
      if (this.primary && this.release && !panes.get(this.file!)?.has(tr.origin as object)) {
        const changes = deltaToChanges(event.delta);
        if (changes.length) {
          this.view.dispatch({ changes, annotations: [fromYjs.of(true), Transaction.addToHistory.of(false)] });
        }
      }
      this.scheduleRefresh();
    }

    private refreshQueued = false;
    private scheduleRefresh() {
      if (this.refreshQueued) return;
      this.refreshQueued = true;
      queueMicrotask(() => {
        this.refreshQueued = false;
        if (this.file) this.view.dispatch({ effects: refresh.of(null) });
      });
    }

    update(u: ViewUpdate) {
      this.attach();
      const file = this.file;
      if (!file) return;
      const own = u.transactions.filter((tr) => tr.docChanged && !tr.annotation(fromYjs));
      if (own.length && this.release) {
        // Obsidian mirrors an edit into sibling panes during the typing pane's
        // dispatch, possibly before this plugin has seen it there. Deferring
        // non-human changes lets the typing pane record the edit first, after
        // which the mirrored copy matches the CRDT and is dropped.
        if (!own.every(isHumanEdit)) queueMicrotask(() => this.pushUnknown());
        else if (u.state.doc.toString() !== file.ytext.toJSON()) this.pushHuman(own, file);
      }
      if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) this.computeDecorations();
    }

    private pushUnknown() {
      const file = this.file;
      if (!file || !this.release) return;
      const text = this.view.state.doc.toString();
      if (text !== file.ytext.toJSON()) file.doc.transact(() => setText(file.ytext, text, file.unknown()), this);
    }

    private pushHuman(transactions: readonly Transaction[], file: MarkdownFile) {
      const by = file.human();
      file.doc.transact(() => {
        for (const tr of transactions) {
          let adj = 0;
          tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const text = inserted.sliceString(0, inserted.length, "\n");
            if (toA > fromA) file.ytext.delete(fromA + adj, toA - fromA);
            insertText(file.ytext, fromA + adj, text, by);
            adj += text.length - (toA - fromA);
          });
        }
      }, this);
    }

    private computeDecorations() {
      const file = this.file;
      const doc = this.view.state.doc;
      if (!file || file.ytext.length !== doc.length) {
        this.segments = [];
        this.decorations = Decoration.none;
        return;
      }
      this.segments = attribute(file.ytext);
      const builder = new RangeSetBuilder<Decoration>();
      for (const s of this.segments) if (s.kind !== "unknown") builder.add(s.from, s.to, marks[s.kind]);
      this.decorations = builder.finish();
    }

    destroy() {
      this.detach();
    }
  },
  { decorations: (v) => v.decorations },
);

export function segmentAt(view: EditorView, pos: number): Segment | null {
  return view.plugin(plugin)?.segments.find((s) => s.from <= pos && pos <= s.to) ?? null;
}

export function provenanceExtension(getEngine: () => SyncEngine | null): Extension {
  currentEngine = getEngine;
  const hover = hoverTooltip((view, pos) => {
    const segment = segmentAt(view, pos);
    if (!segment) return null;
    return { pos: segment.from, end: segment.to, above: true, create: () => ({ dom: renderProvenance(segment) }) };
  });
  return [plugin, hover];
}

const KIND_LABEL: Record<Segment["kind"], string> = {
  human: "Written by you",
  "via-agent": "Your words, inserted by an agent",
  agent: "Written by an agent",
  mixed: "Written by you and an agent",
  unknown: "Changed outside Obsidian",
};

export function renderProvenance(segment: Segment): HTMLElement {
  const root = createDiv({ cls: "prov-tooltip" });
  root.createDiv({ cls: `prov-tooltip-kind prov-kind-${segment.kind}`, text: KIND_LABEL[segment.kind] });
  for (const c of segment.contributors) {
    const row = root.createDiv({ cls: "prov-tooltip-row" });
    row.createSpan({ cls: "prov-tooltip-author", text: c.author === "unknown" ? "unknown source" : c.author });
    if (c.why && c.why !== "human-typed") row.createSpan({ cls: "prov-tooltip-why", text: c.why });
    const when = c.at ? new Date(c.at).toLocaleString() : "";
    row.createSpan({ cls: "prov-tooltip-meta", text: [when, c.device].filter(Boolean).join(" · ") });
    if (c.note) root.createDiv({ cls: "prov-tooltip-note", text: c.note });
  }
  return root;
}
