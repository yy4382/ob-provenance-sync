import { Annotation, EditorSelection, RangeSetBuilder, StateEffect, Transaction, type ChangeSpec, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, layer, RectangleMarker, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { attribute, insertText, type Segment } from "@provenance/core";
import diff from "fast-diff";
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

type Band = { from: number; to: number; kind: keyof typeof marks };

/**
 * Every pane showing a file pushes the edits made in it. Obsidian copies each
 * edit into the file's other panes, and reloads a file another program
 * changed, both as "set" transactions, and those are never pushed: copies
 * are already in the CRDT, and the engine merges outside changes from disk.
 * Changes from the CRDT go into one pane per file, the primary, which
 * Obsidian then copies to the rest. The primary is the pane edited last:
 * Obsidian copies edits between panes in a batch after a burst of typing,
 * so any other pane may still be missing text that is already in the CRDT,
 * and converging it would insert that text a second time.
 */
const panes = new Map<MarkdownFile, Set<ProvenanceView>>();

type EditKind = "human" | "unknown" | "copy";

/**
 * Typing, pasting, undo and Obsidian's own editing commands carry a
 * CodeMirror user event and are the human's. Other plugins editing through
 * the Editor API carry none, so their changes are unknown.
 */
function kindOf(tr: Transaction): EditKind {
  const event = tr.annotation(Transaction.userEvent);
  if (event === "set") return "copy";
  return event === undefined ? "unknown" : "human";
}

/** Minimal CodeMirror changes that turn `from` into `to`. */
function diffChanges(from: string, to: string): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let pos = 0;
  for (const [op, chunk] of diff(from, to)) {
    if (op === diff.EQUAL) pos += chunk.length;
    else if (op === diff.INSERT) changes.push({ from: pos, insert: chunk });
    else {
      changes.push({ from: pos, to: pos + chunk.length });
      pos += chunk.length;
    }
  }
  return changes;
}

let currentEngine: () => SyncEngine | null = () => null;
const engine = () => currentEngine();

class ProvenanceView {
  decorations: DecorationSet = Decoration.none;
  segments: Segment[] = [];
  /** Runs of one kind on one line, drawn by the band layer. */
  bands: Band[] = [];
  file: MarkdownFile | null = null;
  private path: string | null = null;
  release: (() => void) | null = null;
  /** Identifies the current attachment, so a binding that resolves after the pane moved on is released. */
  private attached: object | null = null;
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
    const attached = (this.attached = {});
    const current = () => (this.attached === attached ? this.view.state.doc.toString() : null);
    void file.ready
      .then(() => file.bindEditor(current))
      .then((release) => {
        if (this.attached !== attached) return release();
        this.release = release;
        if (this.primary) this.loadFromCrdt();
        this.scheduleRefresh();
      });
  }

  /** Makes the editor show the CRDT's text. Converging by diff makes repeats harmless. */
  private loadFromCrdt() {
    const changes = diffChanges(this.view.state.doc.toString(), this.file!.ytext.toJSON());
    if (changes.length) this.view.dispatch({ changes, annotations: [fromYjs.of(true), Transaction.addToHistory.of(false)] });
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
    this.attached = null;
    this.file = null;
    this.segments = [];
    this.decorations = Decoration.none;
    if (set.size === 0) panes.delete(file);
    else if (wasPrimary) {
      const next = set.values().next().value!;
      if (next.release) next.loadFromCrdt();
    }
  }

  private onYjs(_event: Y.YTextEvent, tr: Y.Transaction) {
    if (this.primary && this.release && !panes.get(this.file!)?.has(tr.origin as ProvenanceView)) this.loadFromCrdt();
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
    if (own.length && this.release) this.push(own, file);
    if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) this.computeDecorations();
  }

  private push(transactions: readonly Transaction[], file: MarkdownFile) {
    const set = panes.get(file);
    if (set && set.values().next().value !== this) panes.set(file, new Set([this, ...set]));
    file.doc.transact(() => {
      for (const tr of transactions) {
        const kind = kindOf(tr);
        // Positions after a skipped copy no longer line up with the CRDT;
        // such batches are rare, and the primary re-converges afterwards.
        if (kind === "copy") break;
        const by = kind === "human" ? file.human() : file.unknown();
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
      this.bands = [];
      this.decorations = Decoration.none;
      return;
    }
    this.segments = attribute(file.ytext);
    // Segments leave out the spaces between sentences. Color those too when the
    // sentences on either side match, so a paragraph reads as one band, and
    // keep the gap only where the kind changes.
    this.bands = [];
    let open: { from: number; to: number; kind: Segment["kind"] } | null = null;
    const flush = () => {
      if (open && open.kind !== "unknown") this.bands.push({ from: open.from, to: open.to, kind: open.kind });
    };
    for (const s of this.segments) {
      if (open && open.kind === s.kind && /^[ \t]*$/.test(doc.sliceString(open.to, s.from))) open.to = s.to;
      else {
        flush();
        open = { from: s.from, to: s.to, kind: s.kind };
      }
    }
    flush();
    // The tint itself is drawn by the band layer. The marks only tell inline
    // code which kind it sits in, since its pill would hide the tint below.
    const builder = new RangeSetBuilder<Decoration>();
    for (const b of this.bands) builder.add(b.from, b.to, marks[b.kind]);
    this.decorations = builder.finish();
  }

  destroy() {
    this.detach();
  }
}

const plugin = ViewPlugin.fromClass(ProvenanceView, { decorations: (v) => v.decorations });

/**
 * Draws each band the way a selection is drawn: one rectangle per visual
 * line, so a wrapped band has a straight left edge, its inner lines reach
 * the right edge, and only its last line stops at the text. Marks can't do
 * this: Obsidian splits them at bold, links and code, and they hug the glyphs.
 */
const bandLayer = layer({
  above: false,
  class: "prov-band-layer",
  update: (u) => u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh))),
  markers(view) {
    const bands = view.plugin(plugin)?.bands ?? [];
    const { from, to } = view.viewport;
    return bands.filter((b) => b.to > from && b.from < to).flatMap((b) => bandRects(view, b));
  },
});

function bandRects(view: EditorView, band: Band): RectangleMarker[] {
  const className = `prov-band prov-band-${band.kind}`;
  const rects = RectangleMarker.forRange(view, className, EditorSelection.range(band.from, band.to)) as RectangleMarker[];
  const node = view.domAtPos(band.from).node;
  const line = (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>(".cm-line");
  if (!rects.length || !line) return rects;
  // forRange runs inner lines across the whole editor. Bring them to this
  // line's own text column, which a list item indents.
  const style = getComputedStyle(line);
  const box = line.getBoundingClientRect();
  const scroller = view.scrollDOM.getBoundingClientRect();
  const base = scroller.left - view.scrollDOM.scrollLeft;
  const left = box.left + parseFloat(style.paddingLeft) - base;
  const right = box.right - parseFloat(style.paddingRight) - base;
  // Rectangles cover the glyphs' height. Grow the first and last by the
  // leftover line spacing so a band is as tall as its lines.
  const first = rects[0]!;
  const pad = Math.max(0, (parseFloat(style.lineHeight) - first.height) / 2);
  return rects.map((r, i) => {
    const l = i > 0 ? left : r.left;
    const rt = i < rects.length - 1 ? right : r.left + (r.width ?? 0);
    const top = i === 0 ? r.top - pad : r.top;
    const bottom = r.top + r.height + (i === rects.length - 1 ? pad : 0);
    return new RectangleMarker(className, l, top, Math.max(0, rt - l), bottom - top);
  });
}

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
  return [plugin, bandLayer, hover];
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
