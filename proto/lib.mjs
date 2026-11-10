// PROTOTYPE driver helpers: a real Obsidian on a copy of test-vault, the plugin syncing on this device only.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eventually, obsidian, sleep } from "../apps/obsidian/e2e/harness.mjs";

export { eventually, sleep };
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function launch() {
  const work = mkdtempSync(join(tmpdir(), "provenance-proto-"));
  const vault = join(work, "vault");
  cpSync(join(repo, "test-vault"), vault, { recursive: true });
  const core = join(vault, ".obsidian/core-plugins.json");
  writeFileSync(core, JSON.stringify({ sync: false, templates: true, "daily-notes": true }));
  const dir = join(vault, ".obsidian/plugins/provenance-sync");
  mkdirSync(dir, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(repo, "apps/obsidian", f), join(dir, f));
  // PLUGIN_JS picks another build of the plugin, so two runs can use different builds at once.
  if (process.env.PLUGIN_JS) cpSync(process.env.PLUGIN_JS, join(dir, "main.js"));
  writeFileSync(join(dir, "data.json"), JSON.stringify({ serverUrl: "", vaultId: "proto", humanName: "tester", deviceName: "proto-mac" }));
  const app = await obsidian({ vault, profile: join(work, "profile") });
  const cdp = await app.open();
  if (!(await eventually(() => cdp.eval(`return !!app.plugins.plugins["provenance-sync"]?.engine?.started`), 30000))) throw new Error("sync never started");
  return { work, vault, app, cdp, ...helpers(cdp, vault) };
}

export const F = (path) => `app.plugins.plugins["provenance-sync"].engine.fileAt(${JSON.stringify(path)})`;
export const P = `window.__provenanceProto`;

function helpers(cdp, vault) {
  const key = async (key, { code = key, text, modifiers = 0, keyCode } = {}) => {
    const base = { key, code, modifiers, ...(keyCode ? { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode } : {}) };
    await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const h = {
    disk: (path) => (existsSync(join(vault, path)) ? readFileSync(join(vault, path), "utf8") : null),
    write: (path, text) => {
      mkdirSync(dirname(join(vault, path)), { recursive: true });
      writeFileSync(join(vault, path), text);
    },
    /** Creates a note on disk and waits until the engine has it loaded. */
    async note(path, text) {
      h.write(path, text);
      if (!(await eventually(() => cdp.eval(`return !!${F(path)}?.loaded`), 10000))) throw new Error(`engine never loaded ${path}`);
      await cdp.eval(`await app.plugins.plugins["provenance-sync"].engine.settle(); return true`);
    },
    /** Opens `path` in the active leaf, with the cursor at the end of `line` (default: end of text). */
    async open(path, line = null) {
      await cdp.eval(`const l = app.workspace.getLeaf(false); await l.openFile(app.vault.getFileByPath(${JSON.stringify(path)}));
        app.workspace.setActiveLeaf(l, { focus: true }); const e = l.view.editor;
        const line = ${line === null ? "e.lastLine()" : line}; e.setCursor({ line, ch: e.getLine(line).length }); e.cm.focus(); return true`);
      await sleep(150);
    },
    type: (text) => cdp.type(text),
    key,
    backspace: async (n) => {
      for (let i = 0; i < n; i++) await key("Backspace", { keyCode: 8 });
    },
    select: (marker) =>
      cdp.eval(`const e = app.workspace.activeEditor.editor; const i = e.getValue().indexOf(${JSON.stringify(marker)});
        if (i < 0) return false; e.setSelection(e.offsetToPos(i), e.offsetToPos(i + ${marker.length})); return true`),
    pane: () => cdp.eval(`return app.workspace.activeEditor?.editor?.getValue() ?? null`),
    /** The text of every pane showing `path`. */
    panes: (path) => cdp.eval(`return app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file?.path === ${JSON.stringify(path)}).map((l) => l.view.editor.getValue())`),
    bound: (path) => cdp.eval(`return ${P}.events.some((e) => e.kind === "bind" && e.path === ${JSON.stringify(path)})`),
    crdt: (path) => cdp.eval(`return ${F(path)}?.ytext.toJSON() ?? null`),
    settle: () => cdp.eval(`await app.plugins.plugins["provenance-sync"].engine.settle(); return true`),
    proto: (expr) => cdp.eval(`const p = ${P}; return ${expr}`),
    setProto: (fields) => cdp.eval(`Object.assign(${P}, ${JSON.stringify(fields)}); return true`),
    /** Waits until the pane, the CRDT and the file agree, then returns all three. */
    async converged(path, ms = 12000) {
      let last;
      const ok = await eventually(async () => {
        await sleep(300);
        last = { disk: h.disk(path), crdt: await h.crdt(path), panes: await h.panes(path) };
        return last.disk === last.crdt && last.panes.every((p) => p === last.crdt);
      }, ms);
      return { ok: !!ok, ...last };
    },
    /** Who wrote each run of the note's text, as [text, author] pairs. */
    authors: (path) => cdp.eval(`return ${F(path)}.ytext.toDelta().map((d) => [d.insert, d.attributes?.pa ?? "none"])`),
  };
  return h;
}
