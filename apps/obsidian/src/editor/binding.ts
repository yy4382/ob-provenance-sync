import { Annotation, RangeSetBuilder, StateEffect, Transaction, type ChangeSpec, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { attribute, insertText, type Provenance, type Segment } from "@provenance/core";
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
 * Only one editor per file talks to Yjs; Obsidian already mirrors a file
 * between split panes, so binding every pane would apply each change twice.
 * The other panes only render decorations.
 */
const primaries = new Map<MarkdownFile, Set<object>>();

/**
 * Typing, pasting, undo and the like carry a CodeMirror user event and are
 * the human's. Changes without one come from Obsidian itself, most notably
 * reloading a file another program changed, so they are unknown.
 */
function provenanceFor(tr: Transaction, file: MarkdownFile): Provenance {
  return tr.annotation(Transaction.userEvent) !== undefined ? file.human() : file.unknown();
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
    private release: (() => void) | null = null;
    private readonly observer = (event: Y.YTextEvent, tr: Y.Transaction) => this.onYjs(event, tr);

    constructor(readonly view: EditorView) {
      this.attach();
    }

    get primary(): boolean {
      return this.file !== null && primaries.get(this.file)?.values().next().value === this;
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
      let set = primaries.get(file);
      if (!set) primaries.set(file, (set = new Set()));
      set.add(this);
      file.ytext.observe(this.observer);
      void file.ready.then(() => {
        if (this.file !== file) return;
        if (this.primary) this.becomePrimary();
        this.scheduleRefresh();
      });
    }

    private becomePrimary() {
      const file = this.file!;
      this.release = file.bindEditor();
      const text = file.ytext.toJSON();
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
      const set = primaries.get(file)!;
      set.delete(this);
      this.release?.();
      this.release = null;
      this.file = null;
      this.segments = [];
      this.decorations = Decoration.none;
      if (set.size === 0) primaries.delete(file);
      else if (wasPrimary) (set.values().next().value as { becomePrimary(): void }).becomePrimary();
    }

    private onYjs(event: Y.YTextEvent, tr: Y.Transaction) {
      if (tr.origin !== this && this.primary && this.release) {
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
      if (u.docChanged && this.primary && this.release) {
        file.doc.transact(() => {
          for (const tr of u.transactions) {
            if (!tr.docChanged || tr.annotation(fromYjs)) continue;
            const by = provenanceFor(tr, file);
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
      if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) this.computeDecorations();
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
