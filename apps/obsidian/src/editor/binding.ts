import { Annotation, ChangeSet, EditorSelection, RangeSetBuilder, StateEffect, Text, Transaction, type ChangeSpec, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, layer, RectangleMarker, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { attribute, rewriteRange, type Segment } from "@provenance/core";
import diff from "fast-diff";
import type { MarkdownView, TFile } from "obsidian";
import type * as Y from "yjs";
import { proto } from "../proto";
import { codeMirrorOf, editKind, fileLoadedInto, fileNamedBy } from "../quirks";
import type { MarkdownFile, PaneLog, SyncEngine, SyncEvent, TextState } from "../sync/engine";

/** PROTOTYPE. A pane's text while it isn't bound: `text` (and its CRDT state, if known) plus `pending`, its own edits since. */
type Log = { text: string; state: TextState | null; pending: ChangeSet };
const freshLog = (text: string, state: TextState | null = null): Log => ({ text, state, pending: ChangeSet.empty(text.length) });

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
/** PROTOTYPE. Every live pane, to find the unbound panes of one note. */
const views = new Set<ProvenanceView>();

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
let log: (event: SyncEvent) => void = () => {};

class ProvenanceView {
  decorations: DecorationSet = Decoration.none;
  segments: Segment[] = [];
  /** Runs of one kind on one line, drawn by the band layer. */
  bands: Band[] = [];
  file: MarkdownFile | null = null;
  /**
   * The file whose text this editor state holds, fixed for this view since each
   * state gets its own. Null for a state that holds no file's text, which
   * binding would merge as a deletion.
   */
  private readonly loaded: TFile | null;
  release: ((shown?: TextState) => void) | null = null;
  /** Identifies the current attachment, so a binding that resolves after the pane moved on is released. */
  private attached: object | null = null;
  /** What this editor showed when it stopped syncing with its note still open, for binding again. */
  private shown: { file: MarkdownFile["id"]; state: TextState } | null = null;
  private readonly observer = (event: Y.YTextEvent, tr: Y.Transaction) => this.onYjs(event, tr);
  /** PROTOTYPE. Kept whenever this state holds a file's text and isn't bound. */
  private log: Log | null = null;

  constructor(readonly view: EditorView) {
    this.loaded = fileLoadedInto(view);
    if (this.loaded) this.log = freshLog(view.state.doc.toString());
    views.add(this);
    proto.record("pane-created", { path: this.loaded?.path ?? null, length: view.state.doc.length });
    this.attach();
  }

  /** PROTOTYPE. Hands the bind this pane's log, and the logs of the note's other unbound panes, with nothing awaited after. */
  private takeLogs(attached: object) {
    if (this.attached !== attached || !this.log) return [];
    const own = this.log;
    this.log = null;
    return [{ own: true, log: logOf(own), placed: () => {} }, ...this.unboundSiblings().map((v) => v.entry())];
  }

  /** PROTOTYPE. This note's other panes that hold a log. */
  unboundSiblings(): ProvenanceView[] {
    return [...views].filter((v) => v !== this && v.loaded !== null && v.loaded === this.loaded && v.log !== null && !v.release);
  }

  /** PROTOTYPE. This pane's log for applyLogs, which restarts it at the state its edits made. */
  entry() {
    const log = this.log!;
    return {
      own: false,
      log: logOf(log),
      placed: (state: TextState) => {
        if (this.log === log) this.log = freshLog(this.view.state.doc.toString(), state);
      },
    };
  }

  /** PROTOTYPE. Adds this update's changes to the log: the pane's own edits, and foreign ones it rebases over. */
  private logTransactions(u: ViewUpdate) {
    if (!this.log) return;
    for (const tr of u.transactions) {
      if (!tr.docChanged) continue;
      if (tr.annotation(fromYjs)) proto.anomaly("crdt-change-while-unbound", { path: this.loaded?.path });
      if (tr.annotation(fromYjs) || editKind(tr) === "copy") this.rebase(tr);
      else this.log.pending = this.log.pending.compose(tr.changes);
    }
    const doc = this.view.state.doc.toString();
    const rebuilt = this.log.pending.apply(Text.of(this.log.text.split("\n"))).toString();
    if (rebuilt !== doc) {
      proto.anomaly("log-out-of-step", { path: this.loaded?.path, rebuilt, doc });
      this.log = freshLog(doc);
    }
  }

  /** A change the pane didn't make (a copy from another pane, or Obsidian reloading the file): it moves the log's text, and its edits over it. */
  private rebase(tr: Transaction) {
    const log = this.log!;
    const anchor = Text.of(log.text.split("\n"));
    const onAnchor = tr.changes.map(log.pending.invert(anchor));
    const text = onAnchor.apply(anchor).toString();
    const pending = log.pending.map(onAnchor);
    const ok = pending.apply(Text.of(text.split("\n"))).toString() === tr.newDoc.toString();
    proto.record("rebase", { path: this.loaded?.path, userEvent: tr.annotation(Transaction.userEvent) ?? null, pendingEdits: !log.pending.empty, ok });
    if (!ok) {
      proto.anomaly("rebase-mismatch", { path: this.loaded?.path, text, doc: tr.newDoc.toString() });
      this.log = freshLog(tr.newDoc.toString());
      return;
    }
    this.log = { text, state: null, pending };
  }

  /** PROTOTYPE. Obsidian is saving this pane's text. While unbound, the save carries the pending edits to disk, so they leave the log. */
  saved(text: string) {
    const doc = this.view.state.doc.toString();
    const target = this.loaded ? (engine()?.fileAt(this.loaded.path) ?? null) : null;
    proto.record("save", { path: this.loaded?.path, bound: !!this.release, matchesDoc: text === doc, pending: this.log ? !this.log.pending.empty : null, engineFile: !!target?.loaded });
    if (this.release || !this.log) return;
    if (text !== doc) {
      proto.anomaly("save-differs-from-unbound-pane", { path: this.loaded?.path, text, doc });
      return;
    }
    // The save carries this pane's edits, and those of the note's other panes it holds as copies:
    // they are applied now, so the save's state is known when it lands and its read adds nothing.
    if (target?.loaded) target.applyLogs([this.entry(), ...this.unboundSiblings().map((v) => v.entry())], "save");
  }

  get primary(): boolean {
    return this.file !== null && panes.get(this.file)?.values().next().value === this;
  }

  /** The pane's file, unless the pane has moved on and the next file's state hasn't arrived. */
  private shownFile(): TFile | null {
    const file = fileNamedBy(this.view);
    return file === this.loaded ? file : null;
  }

  /** The engine may start, or learn the file, after the pane opened it, so this runs on every update. */
  private attach(u?: ViewUpdate) {
    const shown = this.shownFile();
    // A rename is not a load: the pane's text may hold unsaved edits the CRDT already has.
    if (shown && this.file && engine()?.files.get(this.file.id) === this.file) return;
    const file = shown ? (engine()?.fileAt(shown.path) ?? null) : null;
    if (file === this.file) return;
    if (this.file) {
      const why = !shown ? "the pane no longer shows it" : !engine() ? "sync stopped" : "sync has another note at its path";
      log({ level: "debug", message: `An editor stopped syncing this note: ${why}`, path: shown?.path ?? this.file.path });
    }
    this.detach(shown && !engine() ? this.keepShown() : undefined, u);
    if (!file) return;
    this.file = file;
    let set = panes.get(file);
    if (!set) panes.set(file, (set = new Set()));
    set.add(this);
    file.ytext.observe(this.observer);
    const attached = (this.attached = {});
    const current = () => (this.attached === attached ? this.view.state.doc.toString() : null);
    const shownState = this.shown?.file === file.id ? this.shown.state : null;
    this.shown = null;
    const useLog = proto.editLog;
    void file.ready
      .then(() => (proto.bindDelay ? new Promise((r) => setTimeout(r, proto.bindDelay)) : undefined))
      .then(() => (useLog ? file.bindEdits(() => this.takeLogs(attached)) : file.bindEditor(current, shownState)))
      .then((release) => {
        if (this.attached !== attached) return release();
        this.release = release;
        log({ level: "debug", message: "An editor syncs this note", path: file.path });
        if (this.primary) this.loadFromCrdt();
        this.scheduleRefresh();
      });
  }

  /** Makes the editor show the CRDT's text. Converging by diff makes repeats harmless. */
  private loadFromCrdt() {
    const changes = diffChanges(this.view.state.doc.toString(), this.file!.ytext.toJSON());
    if (changes.length) this.view.dispatch({ changes, annotations: [fromYjs.of(true), Transaction.addToHistory.of(false)] });
  }

  /** `shown` is what the editor showed, when it stops syncing with its note still open. */
  private detach(shown?: TextState, u?: ViewUpdate) {
    const file = this.file;
    if (!file) return;
    // PROTOTYPE: the log starts from the text before this update's changes, which weren't pushed.
    if (this.loaded) {
      const text = (u?.startState.doc ?? this.view.state.doc).toString();
      this.log = freshLog(text, shown && shown.text === text ? shown : null);
      proto.record("unbind", { path: this.loaded.path, stateKnown: !!this.log.state });
    }
    file.ytext.unobserve(this.observer);
    const wasPrimary = this.primary;
    const set = panes.get(file)!;
    set.delete(this);
    this.release?.(shown);
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
    try {
      this.attach(u);
      this.trace(u);
      const file = this.file;
      if (!(file && this.release)) this.logTransactions(u);
      if (!file) return;
      const own = u.transactions.filter((tr) => tr.docChanged && !tr.annotation(fromYjs));
      if (own.length && this.release && proto.throwOnce) {
        proto.throwOnce = false;
        throw new Error("simulated binding failure (prototype)");
      }
      if (own.length && this.release) this.push(own, file);
      if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) this.computeDecorations();
    } catch (e) {
      // Rethrowing would make CodeMirror drop this plugin for good, leaving the editor
      // unsynced while the engine writes the file under it and Obsidian merges that into
      // its unsaved typing. Binding again at once merges what the error kept from the CRDT.
      log({ level: "error", message: `An editor's sync failed, so it binds again: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, path: this.file?.path });
      const wasBound = !!this.release;
      this.detach(this.keepShown(), u);
      if (wasBound) this.logTransactions(u);
      this.attach();
    }
  }

  /** PROTOTYPE. Records every document change with its user event and how the binding classifies it. */
  private trace(u: ViewUpdate) {
    for (const tr of u.transactions) {
      if (!tr.docChanged) continue;
      proto.trace({
        path: this.loaded?.path ?? null,
        bound: !!this.release,
        userEvent: tr.annotation(Transaction.userEvent) ?? null,
        kind: tr.annotation(fromYjs) ? "crdt" : editKind(tr),
        addToHistory: tr.annotation(Transaction.addToHistory) ?? null,
        remote: tr.annotation(Transaction.remote) ?? null,
        size: tr.changes.length,
        newLength: tr.newDoc.length,
      });
    }
  }

  /** Remembers what this editor shows, for binding again, as its note stays open. */
  private keepShown(): TextState | undefined {
    if (!this.file) return undefined;
    this.shown = { file: this.file.id, state: this.file.textState() };
    return this.shown.state;
  }

  private push(transactions: readonly Transaction[], file: MarkdownFile) {
    const set = panes.get(file);
    if (set && set.values().next().value !== this) panes.set(file, new Set([this, ...set]));
    file.doc.transact(() => {
      for (const tr of transactions) {
        const kind = editKind(tr);
        // Positions after a skipped copy no longer line up with the CRDT;
        // such batches are rare, and the primary re-converges afterwards.
        if (kind === "copy") break;
        const by = file.human();
        let adj = 0;
        tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          const text = inserted.sliceString(0, inserted.length, "\n");
          rewriteRange(file.ytext, fromA + adj, tr.startState.sliceDoc(fromA, toA), text, by, "literal");
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
    views.delete(this);
    if (this.file) log({ level: "debug", message: "An editor stopped syncing this note: the editor closed or reloaded", path: this.file.path });
    this.detach();
  }
}

const plugin = ViewPlugin.fromClass(ProvenanceView, { decorations: (v) => v.decorations });

const logOf = (log: Log): PaneLog => ({ text: log.text, state: log.state, edits: editsOf(log.pending) });

/** PROTOTYPE. A change set as ranges of the text it applies to, ascending. */
function editsOf(changes: ChangeSet): PaneLog["edits"] {
  const edits: PaneLog["edits"] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => edits.push({ from: fromA, to: toA, text: inserted.sliceString(0, inserted.length, "\n") }));
  return edits;
}

/** PROTOTYPE. Obsidian picked `text` to save from `view`. */
export function paneSaving(view: MarkdownView, text: string) {
  const cm = codeMirrorOf(view);
  const pane = cm?.plugin(plugin);
  if (!pane) proto.record("save", { path: view.file?.path ?? null, pane: false });
  pane?.saved(text);
}

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
  const line = (node.instanceOf(HTMLElement) ? node : node.parentElement)?.closest<HTMLElement>(".cm-line");
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

export function provenanceExtension(getEngine: () => SyncEngine | null, onEvent: (event: SyncEvent) => void): Extension {
  currentEngine = getEngine;
  log = onEvent;
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
