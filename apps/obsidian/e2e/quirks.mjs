// Checks that a real Obsidian still behaves the way src/quirks.ts assumes. Our plugin isn't loaded:
// only quirk-probe, which records and changes nothing, so a failure means Obsidian changed.
//
//   node apps/obsidian/e2e/quirks.mjs
//   OBSIDIAN_BIN=/path/to/Obsidian MOBILE=1 QUIRKS_REPORT=report.json node apps/obsidian/e2e/quirks.mjs
//
// MOBILE=1 emulates the mobile UI inside the desktop app. It covers what the two share, which is
// the editor and the vault, but not WebKit or the mobile file system.
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eventually, obsidian, older, sleep } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = process.env.MOBILE === "1";

const work = mkdtempSync(join(tmpdir(), "provenance-quirks-"));
const vault = join(work, "vault");
mkdirSync(join(vault, ".obsidian/plugins"), { recursive: true });
cpSync(join(here, "quirk-probe"), join(vault, ".obsidian/plugins/quirk-probe"), { recursive: true });
writeFileSync(join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["quirk-probe"]));
writeFileSync(join(vault, ".obsidian/core-plugins.json"), JSON.stringify({ "daily-notes": true, sync: false }));

const instance = await obsidian({ vault, profile: join(work, "profile") });
let cdp;
let notes = 0;

const logOf = (kinds) => cdp.eval(`return window.quirkLog.filter((e) => ${JSON.stringify(kinds)}.includes(e.kind))`);
const clearLog = () => cdp.eval(`window.quirkLog.length = 0; return true`);

/** Creates a note with `text` and opens it in the active pane, ready to type at the start of the last line. */
async function openNote(text = "Saved text.\n") {
  const path = `n${++notes}.md`;
  await cdp.eval(`await app.vault.create(${JSON.stringify(path)}, ${JSON.stringify(text)}); return true`);
  await openExisting(path);
  await clearLog();
  return path;
}

async function openExisting(path) {
  await cdp.eval(`const l = app.workspace.getLeaf(false); await l.openFile(app.vault.getFileByPath(${JSON.stringify(path)}));
    await new Promise((r) => setTimeout(r, 300));
    app.workspace.setActiveLeaf(l, { focus: true }); const e = l.view.editor; e.setCursor({ line: e.lastLine(), ch: 0 }); e.cm.focus(); return true`);
  await sleep(200);
}

/** Waits for Obsidian to have saved everything typed so far. */
const settled = () => sleep(3000);

/** For a probe whose behavior changed in `version`: the same test as requireApiVersion in quirks.ts. */
const since = (version) => !older(report.version, version);

/** Fails a probe with what was seen, so the report shows how the behavior changed. */
function expect(ok, claim, seen) {
  if (!ok) throw new Error(`${claim}\nseen: ${JSON.stringify(seen).slice(0, 2000)}`);
}

// Each `id` is named by a `quirk:` line in src/quirks.ts, which test/quirks.test.ts keeps in step.
const QUIRKS = [
  {
    id: "typing-has-user-event",
    async probe() {
      const path = await openNote();
      await cdp.type("x");
      const edits = (await eventually(async () => {
        const seen = await logOf(["edit"]);
        return seen.length ? seen : undefined;
      })) ?? [];
      expect(edits[0]?.file === path && edits[0].event?.startsWith("input"), "typing is a transaction with an input.* user event", edits);
    },
  },
  {
    id: "commands-have-user-event",
    async probe() {
      await openNote("Word");
      await cdp.eval(`const e = app.workspace.activeEditor.editor; e.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 4 });
        app.commands.executeCommandById("editor:toggle-bold"); return true`);
      await sleep(200);
      await cdp.eval(`app.workspace.activeEditor.editor.undo(); return true`);
      await sleep(200);
      const edits = await logOf(["edit"]);
      const events = edits.map((e) => e.event);
      expect(events.length >= 2 && events.every((e) => e && e !== "set"), "Obsidian's editing commands and undo carry a user event other than set", events);
    },
  },
  {
    id: "editor-api-has-no-user-event",
    async probe() {
      await openNote();
      await cdp.eval(`app.workspace.activeEditor.editor.replaceRange("x", { line: 0, ch: 0 }); return true`);
      const edits = await logOf(["edit"]);
      expect(edits.length === 1 && edits[0].event === null, "an edit through the Editor API carries no user event", edits);
    },
  },
  {
    id: "pane-copies-are-set",
    desktopOnly: true,
    async probe() {
      const edits = await typeInSplitPanes();
      const typing = edits.find((e) => e.event !== "set")?.pane;
      const copies = edits.filter((e) => e.pane !== typing);
      expect(copies.length > 0 && copies.every((e) => e.event === "set"), "the other pane on a note receives each edit as a set transaction", edits);
    },
  },
  {
    id: "typed-edit-precedes-its-copy",
    desktopOnly: true,
    async probe() {
      const edits = await typeInSplitPanes();
      expect(edits[0]?.event?.startsWith("input"), "the typing pane sees an edit before any other pane does", edits);
    },
  },
  {
    id: "outside-reload-is-set",
    async probe() {
      const path = await openNote();
      await settled();
      await clearLog();
      appendFileSync(join(vault, path), "Outside line.\n");
      const edits = await eventually(async () => {
        const seen = await logOf(["edit"]);
        return seen.length ? seen : undefined;
      });
      expect(edits?.length > 0 && edits.every((e) => e.event === "set"), "an open note that another program changed reloads as a set transaction", edits);
    },
  },
  {
    id: "each-file-gets-a-new-state",
    async probe() {
      const first = await openNote("First note.\n");
      const before = await cdp.eval(`return window.quirkLog.length`);
      const second = `n${++notes}.md`;
      await cdp.eval(`await app.vault.create(${JSON.stringify(second)}, "Second note.\\n"); return true`);
      await openExisting(second);
      const states = (await logOf(["state"])).filter((e) => e.file === second);
      expect(before === 0 && states.some((e) => e.doc === "Second note.\n"), "opening a file builds a new editor state that holds its text and names it", { first, states });
    },
  },
  {
    id: "pane-names-next-file-during-read",
    async probe() {
      const next = `n${++notes}.md`;
      await cdp.eval(`await app.vault.create(${JSON.stringify(next)}, "Next note.\\n"); return true`);
      const first = await openNote("Old note.\n");
      await cdp.eval(`const read = app.vault.read;
        app.vault.read = async function (f) { if (f.path === ${JSON.stringify(next)}) await new Promise((r) => setTimeout(r, 400)); return read.call(this, f); };
        const leaf = app.workspace.getLeaf(false);
        const opening = leaf.openFile(app.vault.getFileByPath(${JSON.stringify(next)}));
        await new Promise((r) => setTimeout(r, 100));
        leaf.view.editor.cm.dispatch({});
        await opening; app.vault.read = read; return true`);
      const updates = await logOf(["update"]);
      expect(updates.some((e) => e.file === next && e.doc === "Old note.\n"), "while a file is read, the pane names it and the editor still holds the previous file", { first, updates });
    },
  },
  {
    id: "leaving-unsaved-note-blanks-editor",
    async probe() {
      const path = await openNote();
      const other = `n${++notes}.md`;
      await cdp.eval(`await app.vault.create(${JSON.stringify(other)}, "Other.\\n"); return true`);
      await cdp.type("Unsaved ");
      await clearLog();
      await openExisting(other);
      const states = await logOf(["state"]);
      const blank = states.find((e) => e.file === path);
      expect(blank?.doc === "" && blank.blank === true, "leaving a note with unsaved edits installs a blank state while the pane names that note, with view.data null", states);
    },
  },
  {
    id: "editor-saves-through-vault-modify",
    async probe() {
      const path = await openNote();
      await cdp.type("Saved by the editor ");
      await settled();
      const text = await cdp.eval(`return app.workspace.activeEditor.editor.getValue()`);
      const saves = (await logOf(["vault.modify"])).filter((e) => e.file === path);
      expect(saves.some((e) => e.data === text), "an editor saves by calling app.vault.modify with the exact text it shows, and that call can be wrapped", { text, saves });
    },
  },
  {
    id: "leaving-unsaved-note-saves-through-vault-modify",
    async probe() {
      const path = await openNote("Line.\n");
      const other = `n${++notes}.md`;
      await cdp.eval(`await app.vault.create(${JSON.stringify(other)}, "Other.\\n"); return true`);
      await cdp.type("Unsaved ");
      await openExisting(other);
      await sleep(500);
      const saves = (await logOf(["vault.modify"])).filter((e) => e.file === path);
      expect(saves.some((e) => e.data === "Line.\nUnsaved "), "the save made on leaving a note also goes through app.vault.modify", saves);
    },
  },
  {
    id: "process-skips-unchanged-write",
    async probe() {
      const path = await openNote();
      await settled();
      await clearLog();
      await cdp.eval(`await app.vault.process(app.vault.getFileByPath(${JSON.stringify(path)}), (data) => data); return true`);
      await sleep(500);
      const events = (await logOf(["modify-event"])).filter((e) => e.file === path);
      expect(events.length === 0, "vault.process writes nothing, and fires no modify event, when the text doesn't change", events);
    },
  },
  {
    id: "rename-keeps-editor-state",
    async probe() {
      const path = await openNote();
      await cdp.type("Unsaved ");
      const moved = `moved-${path}`;
      await clearLog();
      await cdp.eval(`await app.vault.rename(app.vault.getFileByPath(${JSON.stringify(path)}), ${JSON.stringify(moved)}); app.workspace.activeEditor.editor.cm.dispatch({}); return true`);
      await sleep(200);
      const seen = await logOf(["state", "update"]);
      expect(
        !seen.some((e) => e.kind === "state") && seen.some((e) => e.kind === "update" && e.file === moved && e.sameFileObject && e.doc.includes("Unsaved")),
        "renaming an open note keeps its editor state, its unsaved text and the same TFile object",
        seen,
      );
    },
  },
  {
    id: "editor-has-cm",
    async probe() {
      await openNote();
      const ok = await cdp.eval(`return window.quirkProbe.isEditorView(app.workspace.activeEditor.editor.cm)`);
      expect(ok, "a markdown view's editor exposes its EditorView as .cm", ok);
    },
  },
  {
    id: "plugin-lists-are-readable",
    async probe() {
      const seen = await cdp.eval(`return {
        probeOn: app.plugins.enabledPlugins instanceof Set && app.plugins.enabledPlugins.has("quirk-probe"),
        coreOn: !!app.internalPlugins.getEnabledPluginById("daily-notes"),
        coreOff: app.internalPlugins.getEnabledPluginById("sync") === null,
      }`);
      expect(seen.probeOn && seen.coreOn && seen.coreOff, "app.plugins.enabledPlugins is a Set of ids, and getEnabledPluginById returns null for a plugin that is off", seen);
    },
  },
  {
    id: "daily-notes-internals",
    async probe() {
      const seen = await cdp.eval(`const d = app.internalPlugins.getEnabledPluginById("daily-notes");
        return { getDailyNote: typeof d?.getDailyNote, getFormat: typeof d?.getFormat, options: typeof d?.options }`);
      expect(seen.getDailyNote === "function" && seen.getFormat === "function" && seen.options === "object", "the daily notes plugin has getDailyNote(), getFormat() and options", seen);
      await cdp.eval(`await app.vault.createFolder("Journal"); return true`);
      for (const options of [{}, { folder: "Journal" }, { format: "YYYY/MM/YYYY-MM-DD" }]) {
        const paths = await cdp.eval(`const d = app.internalPlugins.getEnabledPluginById("daily-notes");
          d.options = ${JSON.stringify(options)};
          const name = window.moment().format(d.getFormat()).trim();
          const folder = d.options.folder ? app.vault.getFolderByPath(d.options.folder) : app.fileManager.getNewFileParent("");
          const worked = (folder.isRoot() ? "" : folder.path + "/") + name + ".md";
          const before = app.vault.getFileByPath(worked);
          return { worked, before: !!before, created: (await d.getDailyNote())?.path }`);
        expect(!paths.before && paths.created === paths.worked, "getDailyNote() puts today's note where its options say", { options, paths });
        if (!mobile) {
          const told = instance.cli("daily:path").stdout.trim();
          expect(told === paths.worked, "daily:path agrees with getDailyNote()", { options, told, paths });
        }
      }
      await cdp.eval(`app.internalPlugins.getEnabledPluginById("daily-notes").options = {}; return true`);
    },
  },
  {
    id: "cli-reply-is-stdout",
    desktopOnly: true,
    async probe() {
      const reply = JSON.stringify({ text: "line one\nline two 中文 🧠" });
      await cdp.eval(`window.quirkProbe.cliReply = ${JSON.stringify(reply)}; return true`);
      const answered = instance.cli("quirk-probe");
      expect(answered.status === 0 && answered.stdout === `${reply}\n`, "obsidian prints what a CLI handler returns, plus a newline", answered);
      const missing = instance.cli("no-such-command");
      expect(missing.status === 0 && missing.stdout.startsWith("Error:"), "a command nobody registered prints plain text and exits 0", missing);
    },
  },
  {
    id: "app-id-is-a-string",
    async probe() {
      const seen = await cdp.eval(`return typeof app.appId`);
      expect(seen === "string", "app.appId names this vault on this device", seen);
    },
  },
  // Stays last: it kills the instance.
  {
    id: "cli-cut-off-prints-nothing",
    desktopOnly: true,
    async probe() {
      await cdp.eval(`window.quirkProbe.cliReply = new Promise(() => {}); return true`);
      const call = spawn("obsidian", ["vault=e2evault", "quirk-probe"], { env: instance.env });
      let printed = "";
      call.stdout.on("data", (d) => (printed += d));
      const status = new Promise((done) => call.on("close", done));
      await sleep(1500);
      await instance.kill();
      const seen = { status: await status, printed };
      expect(seen.status === 0 && seen.printed === "", "a client whose Obsidian dies mid-call exits 0 having printed nothing", seen);
      const gone = instance.cli("quirk-probe");
      expect(gone.status === 1 && gone.stdout === "", "with Obsidian gone, the client exits 1", gone);
    },
  },
];

/** Types in one of two panes on a new note and resolves to every edit, once the other pane has its copy. */
async function typeInSplitPanes() {
  const path = await openNote();
  await cdp.eval(`await app.workspace.getLeaf("split").openFile(app.vault.getFileByPath(${JSON.stringify(path)}));
    await new Promise((r) => setTimeout(r, 500)); return true`);
  await clearLog();
  await cdp.type("Typed ");
  await sleep(1000);
  const edits = (await logOf(["edit"])).filter((e) => e.file === path);
  await cdp.eval(`app.workspace.activeLeaf.detach(); return true`);
  return edits;
}

const report = { version: null, mobile, results: [] };
let failures = 0;
try {
  cdp = await instance.open();
  if (!(await eventually(() => cdp.eval(`return !!window.quirkLog`), 10000))) throw new Error("quirk-probe did not load");
  report.version = await cdp.eval(`return window.quirkProbe.apiVersion`);
  if (mobile) {
    // It reloads the page, which loads the probe again in the new mode.
    await cdp.eval(`app.emulateMobile(true); return true`).catch(() => undefined);
    await eventually(() => cdp.eval(`return window.quirkProbe?.isMobile && app.workspace.layoutReady`), 15000);
    if (!(await cdp.eval(`return window.quirkProbe?.isMobile && document.body.classList.contains("is-mobile")`))) throw new Error("the mobile UI did not turn on");
  }
  console.log(`Obsidian ${report.version}${mobile ? ", mobile UI" : ""}`);
  for (const { id, desktopOnly, probe } of QUIRKS) {
    if (desktopOnly && mobile) {
      console.log(`SKIP  ${id}`);
      report.results.push({ id, status: "skip" });
      continue;
    }
    try {
      await probe();
      console.log(`PASS  ${id}`);
      report.results.push({ id, status: "pass" });
    } catch (e) {
      failures++;
      const detail = e instanceof Error ? e.message : String(e);
      console.log(`FAIL  ${id}\n      ${detail}`);
      report.results.push({ id, status: "fail", detail });
    }
  }
  cdp.close();
} catch (e) {
  failures++;
  console.log(`FAIL  run completed  ${e instanceof Error ? e.stack : String(e)}`);
  report.results.push({ id: "run-completed", status: "fail", detail: String(e) });
} finally {
  await instance.kill();
  if (process.env.QUIRKS_REPORT) writeFileSync(resolve(process.env.QUIRKS_REPORT), JSON.stringify(report, null, 2));
  rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} quirk(s) changed` : "\nevery quirk holds");
process.exit(failures ? 1 : 0);
