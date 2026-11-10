import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { around } from "monkey-around";
import { editorInfoField, MarkdownView, moment, normalizePath, requireApiVersion, TextFileView, type App, type DataWriteOptions, type TFile } from "obsidian";

/**
 * What this plugin relies on that Obsidian doesn't promise. Each `quirk:` line
 * names a probe in e2e/quirks.mjs, which runs against real Obsidian releases.
 *
 * One build runs on every device, and devices reach a new Obsidian at
 * different times, so a release that changes something here must not simply
 * replace the old code: branch on requireApiVersion in the function concerned,
 * and drop the old branch once minAppVersion passes that release.
 */

/**
 * Core refuses a new note's name that Obsidian can't use, so an agent hears at
 * once instead of finding the note never reached the disk. The list is Obsidian's.
 *
 * quirk: note-names-obsidian-cannot-use
 */

export type EditKind = "local" | "copy";

/**
 * Obsidian copying an edit into the file's other panes, or reloading a file
 * another program changed, is "set". Every other edit is local: typing,
 * Obsidian's commands, a click on a task, and other plugins through the
 * Editor API, which carry no user event.
 *
 * quirk: typing-has-user-event
 * quirk: commands-have-user-event
 * quirk: editor-api-has-no-user-event
 * quirk: pane-copies-are-set
 * quirk: typed-edit-precedes-its-copy
 * quirk: outside-reload-is-set
 */
export function editKind(tr: Transaction): EditKind {
  return tr.annotation(Transaction.userEvent) === "set" ? "copy" : "local";
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
 * Reports every note write through the Vault API except the engine's own
 * (`syncWriteOptions`). An editor's save goes to `started` as soon as it has
 * picked its text, since it waits on other file operations before writing,
 * and then to `save` with the exact text it writes, which the engine needs to
 * tell the save from other programs' edits.
 * Any other write, from another plugin or a click on a task in reading view
 * (`clickingTask`), goes to `local` with the text it replaces and the text it
 * writes, before it lands. Returns the undo.
 *
 * quirk: editor-saves-through-vault-modify
 * quirk: leaving-unsaved-note-saves-through-vault-modify
 * quirk: editor-save-identifies-written-text
 * quirk: editor-save-marker-is-consumed-once
 * quirk: vault-text-writes-do-not-nest
 */
export function wrapVaultWrites(
  app: App,
  track: {
    started: (file: TFile, done: Promise<unknown>) => void;
    /** PROTOTYPE: which pane is saving, and the text it picked. */
    picked: (view: MarkdownView, text: string) => void;
    save: (file: TFile, data: string, write: () => Promise<void>) => Promise<void>;
    local: (path: string, before: string, after: string) => void;
  },
): () => void {
  const vault = app.vault;
  const saves = new Map<TFile, Set<{ text: string }>>();
  const saving = (view: TextFileView, file: TFile | null, text: string, write: () => Promise<void>) => {
    if (view.app !== app || !file || !(view instanceof MarkdownView) || clickingTask()) return write();
    track.picked(view, text);
    const save = { text };
    let pending = saves.get(file);
    if (!pending) saves.set(file, (pending = new Set()));
    pending.add(save);
    const done = write().finally(() => {
      pending.delete(save);
      if (!pending.size && saves.get(file) === pending) saves.delete(file);
    });
    track.started(file, done);
    return done;
  };
  // 1.15 reads the view after waiting for a previous save, at writeData entry.
  const unwatchSaves = requireApiVersion("1.15.0")
    ? around(TextFileView.prototype as TextFileWriter, {
        writeData: (next) =>
          function (this: TextFileWriter, file, data, previous) {
            return saving(this, file, data, () => next.call(this, file, data, previous));
          },
      })
    : around(TextFileView.prototype, {
        save: (next) =>
          function (this: TextFileView, clear) {
            if (!this.file) return next.call(this, clear);
            return saving(this, this.file, this.getViewData(), () => next.call(this, clear));
          },
      });
  const untracked = (path: string, options?: DataWriteOptions) => !path.endsWith(".md") || (options !== undefined && SYNC_WRITE in options);
  const before = (file: TFile) => vault.read(file).catch(() => "");
  const unwatchWrites = around(vault, {
    create: (next) => (path, data, options) => {
      if (!untracked(path, options)) track.local(normalizePath(path), "", data);
      return next.call(vault, path, data, options);
    },
    modify: (next) => async (file, data, options) => {
      const write = () => next.call(vault, file, data, options);
      if (untracked(file.path, options)) return write();
      const pending = saves.get(file);
      const save = [...(pending ?? [])].find((s) => s.text === data);
      if (save) {
        pending!.delete(save);
        return track.save(file, data, write);
      }
      track.local(file.path, await before(file), data);
      return write();
    },
    process: (next) => (file, fn, options) => {
      if (untracked(file.path, options)) return next.call(vault, file, fn, options);
      return next.call(vault, file, (data) => {
        const result = fn(data);
        track.local(file.path, data, result);
        return result;
      }, options);
    },
    append: (next) => async (file, data, options) => {
      if (!untracked(file.path, options)) {
        const text = await before(file);
        track.local(file.path, text, text + data);
      }
      return next.call(vault, file, data, options);
    },
  });
  return () => {
    unwatchWrites();
    unwatchSaves();
  };
}

/**
 * Whether a click on a task's checkbox is being handled right now. In reading
 * view, Obsidian saves the clicked text through the view's save from inside that
 * event. That save is the click's edit, not text the editor showed, even when it
 * puts back an earlier text. The event is on `window` for a popout's clicks too,
 * since the main window's code handles them.
 *
 * quirk: reading-view-task-click-saves-in-its-event
 */
function clickingTask(): boolean {
  const { event } = window as unknown as { event?: { target: Partial<Element> | null } };
  return !!event?.target?.classList?.contains("task-list-item-checkbox");
}

interface TextFileWriter extends TextFileView {
  writeData(file: TFile, data: string, previous: string): Promise<void>;
}

const SYNC_WRITE = Symbol("provenance-sync-write");
/** Options that mark a vault write as the engine's own, so `wrapVaultWrites` leaves it alone. */
export const syncWriteOptions = (): DataWriteOptions => ({ [SYNC_WRITE]: true }) as DataWriteOptions;

/**
 * Writes `text` only if the file still holds `expected`, as one step of
 * Obsidian's file queue, leaving the file alone otherwise. Resolves to whether it wrote.
 *
 * quirk: process-skips-unchanged-write
 */
export async function replaceIfHolds(app: App, file: TFile, expected: string, text: string): Promise<boolean> {
  let wrote = false;
  await app.vault.process(file, (data) => (data === expected ? ((wrote = true), text) : data), syncWriteOptions());
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
  /** Creates today's note from the template if it's missing. Resolves to nothing if it can't. */
  getDailyNote?(): Promise<TFile | null | undefined>;
  getFormat?(): string;
  options?: { folder?: string };
}

/** quirk: daily-notes-internals */
export function dailyNotesPlugin(app: App): DailyNotes | null {
  return (internals(app).internalPlugins?.getEnabledPluginById?.("daily-notes") as DailyNotes | null | undefined) ?? null;
}

/**
 * Where getDailyNote() puts today's note, without creating it, or null if the
 * configured folder is missing.
 *
 * quirk: daily-notes-internals
 */
export function dailyNotePath(app: App, daily: DailyNotes): string | null {
  const name = moment().format(daily.getFormat?.()).trim();
  const folder = daily.options?.folder ? app.vault.getFolderByPath(normalizePath(daily.options.folder)) : app.fileManager.getNewFileParent("");
  if (!folder) return null;
  return `${folder.isRoot() ? "" : `${folder.path}/`}${name}.md`;
}

/**
 * ob-provenance reads what a handler from registerCliHandler returns off the
 * stdout of `obsidian`, which exits 0 even when the command failed.
 *
 * quirk: cli-reply-is-stdout
 */

/**
 * Each vault's plugin registers the same CLI command, and `obsidian vault=<id>`
 * runs the one in that vault, so ob-provenance reaches the vault it selected.
 *
 * quirk: cli-handler-runs-in-named-vault
 */
