import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { around } from "monkey-around";
import { editorInfoField, TextFileView, type App, type MarkdownView, type TFile } from "obsidian";

/**
 * What this plugin relies on that Obsidian doesn't promise. Each `quirk:` line
 * names a probe in e2e/quirks.mjs, which runs against real Obsidian releases.
 *
 * One build runs on every device, and devices reach a new Obsidian at
 * different times, so a release that changes something here must not simply
 * replace the old code: branch on requireApiVersion in the function concerned,
 * and drop the old branch once minAppVersion passes that release.
 */

export type EditKind = "human" | "unknown" | "copy";

/**
 * Typing, pasting, undo and Obsidian's own editing commands carry a CodeMirror
 * user event and are the human's. Other plugins editing through the Editor API
 * carry none, so their changes are unknown. Obsidian copying an edit into the
 * file's other panes, or reloading a file another program changed, is "set".
 *
 * quirk: typing-has-user-event
 * quirk: commands-have-user-event
 * quirk: editor-api-has-no-user-event
 * quirk: pane-copies-are-set
 * quirk: typed-edit-precedes-its-copy
 * quirk: outside-reload-is-set
 */
export function editKind(tr: Transaction): EditKind {
  const event = tr.annotation(Transaction.userEvent);
  if (event === "set") return "copy";
  return event === undefined ? "unknown" : "human";
}

/**
 * The file whose text a new editor state holds. Obsidian loads each file into
 * a new state, so the pane's file on arrival is the file. It is null for the
 * blank state Obsidian installs when leaving a file with unsaved edits, while
 * the pane still names that file: the state holds no file's text.
 *
 * quirk: each-file-gets-a-new-state
 * quirk: leaving-unsaved-note-blanks-editor
 */
export function fileLoadedInto(view: EditorView): TFile | null {
  const info = view.state.field(editorInfoField, false);
  return info instanceof TextFileView && info.data === null ? null : (info?.file ?? null);
}

/**
 * The file the pane names, which runs ahead of the text: the pane names the
 * next file while that file is still being read. A rename keeps the state and
 * the TFile, so compare with `fileLoadedInto` by identity to tell them apart.
 *
 * quirk: pane-names-next-file-during-read
 * quirk: rename-keeps-editor-state
 */
export function fileNamedBy(view: EditorView): TFile | null {
  return view.state.field(editorInfoField, false)?.file ?? null;
}

/** quirk: editor-has-cm */
export function codeMirrorOf(view: MarkdownView): EditorView | null {
  return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
}

/**
 * Calls `track` around every vault.modify, which is how an editor saves, with
 * the exact text it writes. Resolves like the write; returns the undo.
 *
 * quirk: editor-saves-through-vault-modify
 * quirk: leaving-unsaved-note-saves-through-vault-modify
 */
export function wrapEditorSaves(app: App, track: (file: TFile, data: string, write: () => Promise<void>) => Promise<void>): () => void {
  const vault = app.vault;
  return around(vault, {
    modify: (next) => (file, data, options) => track(file, data, () => next.call(vault, file, data, options)),
  });
}

/**
 * Writes `text` only if the file still holds `expected`, as one step of
 * Obsidian's file queue, leaving the file alone otherwise. Resolves to whether it wrote.
 *
 * quirk: process-skips-unchanged-write
 */
export async function replaceIfHolds(app: App, file: TFile, expected: string, text: string): Promise<boolean> {
  let wrote = false;
  await app.vault.process(file, (data) => (data === expected ? ((wrote = true), text) : data));
  return wrote;
}

/** Internals, typed only as far as this file reads them. */
interface Internals {
  appId?: string;
  internalPlugins?: { getEnabledPluginById?(id: string): unknown };
  plugins?: { enabledPlugins?: Set<string> };
}

const internals = (app: App) => app as unknown as Internals;

/** quirk: plugin-lists-are-readable */
export function corePluginOn(app: App, id: string): boolean {
  return !!internals(app).internalPlugins?.getEnabledPluginById?.(id);
}

/** quirk: plugin-lists-are-readable */
export function communityPluginOn(app: App, id: string): boolean {
  return !!internals(app).plugins?.enabledPlugins?.has(id);
}

/** quirk: app-id-is-a-string */
export function deviceVaultId(app: App): string {
  return internals(app).appId ?? app.vault.getName();
}

export interface DailyNotes {
  getDailyNote?(): Promise<TFile | null>;
  options?: { folder?: string };
}

/** quirk: daily-notes-internals */
export function dailyNotesPlugin(app: App): DailyNotes | null {
  return (internals(app).internalPlugins?.getEnabledPluginById?.("daily-notes") as DailyNotes | null | undefined) ?? null;
}

/**
 * ob-provenance reads what a handler from registerCliHandler returns off the
 * stdout of `obsidian`, which exits 0 even when the command failed.
 *
 * quirk: cli-reply-is-stdout
 */
