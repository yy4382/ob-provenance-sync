// PROTOTYPE. Drives many real interactions that change a note's text in a real Obsidian, once with the
// pane held unbound and once bound, with the edit-log bind on, and records what the edit log made of each.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { eventually, F, launch, P, sleep } from "./lib.mjs";

const D = Number(process.env.BIND_DELAY ?? 6000);
const o = await launch();
const { cdp } = o;
const results = [];
const count = (text, word) => (text ?? "").split(word).length - 1;
const J = JSON.stringify;

const port = execSync("ps -ax -o args")
  .toString()
  .split("\n")
  .find((l) => l.includes(`${basename(o.work)}/profile`) && l.includes("remote-debugging-port="))
  ?.match(/remote-debugging-port=(\d+)/)?.[1];

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const send = (method, params) =>
    new Promise((res) => {
      const my = ++id;
      const on = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id === my) {
          ws.removeEventListener("message", on);
          res(msg.result);
        }
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function popoutClient() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  for (const t of targets.filter((t) => t.type === "page")) {
    const c = await connect(t.webSocketDebuggerUrl);
    const r = await c.send("Runtime.evaluate", { expression: "document.body.classList.contains('is-popout-window')", returnByValue: true });
    if (r?.result?.value) {
      await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      return c;
    }
    c.close();
  }
  return null;
}

const ed = `app.workspace.activeEditor.editor`;
const cmd = (id) => cdp.eval(`return app.commands.executeCommandById(${J(id)})`);
const cursor = (line, ch = null) =>
  cdp.eval(`const e = ${ed}; e.setCursor({ line: ${line}, ch: ${ch === null ? `e.getLine(${line}).length` : ch} }); e.cm.focus(); return true`);
const charKey = (ch) => {
  if (ch === " ") return o.key(" ", { code: "Space", text: " ", keyCode: 32 });
  const up = ch.toUpperCase();
  return o.key(ch, { code: /[a-z]/i.test(ch) ? `Key${up}` : ch, text: ch, keyCode: up.charCodeAt(0) });
};
const keys = async (s) => {
  for (const ch of s) {
    await charKey(ch);
    await sleep(40);
  }
};
const enter = () => o.key("Enter", { code: "Enter", text: "\r", keyCode: 13 });
const escape = () => o.key("Escape", { code: "Escape", keyCode: 27 });
const selectAllKeys = async (c = cdp) => {
  const base = { key: "a", code: "KeyA", modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ["selectAll"] };
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
};
const clip = (type, data) =>
  cdp.eval(`const dt = new DataTransfer(); for (const [k, v] of Object.entries(${J(data)})) dt.setData(k, v);
    const ev = new ClipboardEvent(${J(type)}, { clipboardData: dt, bubbles: true, cancelable: true });
    ${ed}.cm.contentDOM.dispatchEvent(ev); return { prevented: ev.defaultPrevented, data: dt.getData("text/plain") }`);
const file = (path) => `app.vault.getFileByPath(${J(path)})`;
const view = `app.workspace.activeLeaf.view`;

/** Per pane on `path`: bound or not, and whether its log's text is one the CRDT can place. */
const inspect = (path) =>
  cdp.eval(`const f = ${F(path)}; const out = [];
    for (const l of app.workspace.getLeavesOfType("markdown")) {
      if (l.view.file?.path !== ${J(path)}) continue;
      const cm = l.view.editor?.cm;
      const v = cm?.plugins?.find((x) => x?.value && (typeof x.value.takeLog === "function" || typeof x.value.takeLogs === "function"))?.value;
      const doc = cm?.state.doc.toString();
      let place = null;
      if (v?.log) place = v.log.state ? "kept" : (f?.stateOfText(v.log.text)?.how ?? "NONE");
      out.push({ mode: l.view.getMode(), popout: l.view.containerEl.win !== window, bound: !!v?.release, log: !!v?.log,
        pending: v?.log ? !v.log.pending.empty : null, logText: v?.log ? v.log.text : null, logPlace: place, docIsCrdt: doc === f?.ytext.toJSON() });
    }
    return out;`);

const S = {};
const nl = "\n";

S["ime compose"] = {
  base: "IME." + nl,
  async run() {
    for (const s of ["n", "ni", "你", "你h", "你ha", "你hao", "你好"]) {
      await cdp.send("Input.imeSetComposition", { text: s, selectionStart: s.length, selectionEnd: s.length });
      await sleep(80);
    }
    await cdp.send("Input.insertText", { text: "你好" });
  },
  expect: "IME.你好\n",
  markers: ["你好"],
};

S["ime spans bind or remote change"] = {
  base: "IME." + nl,
  delay: 1500,
  async run(ctx) {
    for (const s of ["n", "ni", "你", "你h", "你ha", "你hao", "你好"]) {
      await cdp.send("Input.imeSetComposition", { text: s, selectionStart: s.length, selectionEnd: s.length });
      await sleep(400);
      if (ctx.mode === "bound" && s === "你h") await cdp.eval(`const f = ${F(ctx.p)}; f.ytext.insert(0, "R "); await f.flush(); return true`);
    }
    ctx.note("composing pane before commit", await o.pane());
    await cdp.send("Input.insertText", { text: "你好" });
  },
  expect: (ctx) => (ctx.mode === "bound" ? "R IME.你好\n" : "IME.你好\n"),
  markers: ["你好"],
};

S["paste plain"] = {
  base: "Paste." + nl,
  async run(ctx) {
    ctx.note("event", await clip("paste", { "text/plain": " pasted words" }));
  },
  expect: "Paste. pasted words\n",
  markers: ["pasted words"],
};

S["paste html"] = {
  base: "Html." + nl,
  async run(ctx) {
    ctx.note("event", await clip("paste", { "text/html": "<p><b>bold</b> html</p>", "text/plain": "bold html" }));
  },
  markers: ["bold"],
};

S["paste url over selection"] = {
  base: "Link here." + nl,
  async run(ctx) {
    await o.select("Link");
    ctx.note("event", await clip("paste", { "text/plain": "https://example.com/x" }));
  },
  expect: "[Link](https://example.com/x) here.\n",
  markers: ["](https://example.com/x)"],
};

S["cut"] = {
  base: "Cut this word." + nl,
  async run(ctx) {
    await o.select(" word");
    ctx.note("event", await clip("cut", {}));
  },
  expect: "Cut this.\n",
};

S["undo redo across the bind"] = {
  base: "Undo." + nl,
  async run(ctx) {
    await o.type(" one");
    await sleep(800);
    await o.type(" two");
    await sleep(800);
    if (ctx.mode === "unbound") ctx.note("bound before undo", !!(await ctx.waitBound()));
    await cdp.eval(`${ed}.undo(); return true`);
    await sleep(250);
    ctx.note("after undo 1", await o.pane());
    await cdp.eval(`${ed}.undo(); return true`);
    await sleep(250);
    ctx.note("after undo 2", await o.pane());
    await cdp.eval(`${ed}.redo(); return true`);
    await sleep(250);
  },
  expect: "Undo. one\n",
  markers: [" one"],
  absent: ["two"],
};

S["undo before the bind"] = {
  base: "Undo." + nl,
  async run() {
    await o.type(" one");
    await sleep(800);
    await o.type(" two");
    await sleep(300);
    await cdp.eval(`${ed}.undo(); return true`);
    await sleep(250);
    await cdp.eval(`${ed}.redo(); return true`);
    await sleep(250);
    await cdp.eval(`${ed}.undo(); return true`);
  },
  expect: "Undo. one\n",
  markers: [" one"],
  absent: ["two"],
};

S["vim i text esc x dd u p"] = {
  base: "Vim one.\nVim two.\n",
  async before() {
    await cdp.eval(`app.vault.setConfig("vimMode", true); return true`);
  },
  async run(ctx) {
    await keys("i");
    await keys("abc");
    await escape();
    await sleep(100);
    ctx.note("after insert", await o.pane());
    await keys("x");
    await sleep(100);
    await keys("dd");
    await sleep(100);
    ctx.note("after dd", await o.pane());
    await keys("u");
    await sleep(150);
    await keys("p");
    await sleep(150);
  },
  async after() {
    await cdp.eval(`app.vault.setConfig("vimMode", false); return true`);
  },
  markers: ["Vim two."],
};

S["cmd toggle bold"] = {
  base: "Make bold here." + nl,
  async run() {
    await o.select("bold");
    await cmd("editor:toggle-bold");
  },
  expect: "Make **bold** here.\n",
  markers: ["**"],
};

S["cmd swap line down"] = {
  base: "First.\nSecond.\n",
  async run() {
    await cursor(0);
    await cmd("editor:swap-line-down");
  },
  expect: "Second.\nFirst.\n",
};

S["cmd toggle checklist"] = {
  base: "- item" + nl,
  async run() {
    await cursor(0);
    await cmd("editor:toggle-checklist-status");
  },
  expect: "- [ ] item\n",
  markers: ["[ ]"],
};

S["cmd delete paragraph"] = {
  base: "Keep.\n\nDrop this.\n\nKeep too.\n",
  async run() {
    await cursor(2);
    await cmd("editor:delete-paragraph");
  },
  absent: ["Drop this"],
};

S["key tab indents list item"] = {
  base: "- a\n- b\n",
  async run() {
    await cursor(1);
    await o.key("Tab", { code: "Tab", keyCode: 9 });
  },
  expect: "- a\n\t- b\n",
};

S["key enter continues list"] = {
  base: "- a" + nl,
  async run() {
    await cursor(0);
    await enter();
    await sleep(100);
    await o.type("b");
  },
  expect: "- a\n- b\n",
  markers: ["- b"],
};

S["auto-paired brackets"] = {
  base: "Pair." + nl,
  async run() {
    await o.type(" (x) [a]");
  },
  expect: "Pair. (x) [a]\n",
  markers: ["(x)", "[a]"],
};

S["link autocomplete"] = {
  base: "Link" + nl,
  async run(ctx) {
    await o.type(" [[Wel");
    await sleep(700);
    ctx.note("suggestion", await cdp.eval(`return [...document.querySelectorAll(".suggestion-container .suggestion-item")].map((e) => e.innerText.slice(0, 40))`));
    await enter();
    await sleep(200);
  },
  expect: "Link [[Welcome]]\n",
  markers: ["[[Welcome]]"],
};

S["processFrontMatter clean"] = {
  base: "---\nstatus: draft\n---\nBody.\n",
  line: 3,
  async run(ctx) {
    await cdp.eval(`await app.fileManager.processFrontMatter(${file(ctx.p)}, (fm) => { fm.status = "done"; }); return true`);
    await sleep(800);
  },
  expect: "---\nstatus: done\n---\nBody.\n",
  markers: ["done"],
};

S["processFrontMatter with typing"] = {
  base: "---\nstatus: draft\n---\nBody.\n",
  line: 3,
  async run(ctx) {
    await o.type(" typed");
    await sleep(100);
    await cdp.eval(`await app.fileManager.processFrontMatter(${file(ctx.p)}, (fm) => { fm.status = "done"; }); return true`);
    await sleep(800);
  },
  expect: "---\nstatus: done\n---\nBody. typed\n",
  markers: ["done", " typed"],
};

S["properties editor insertProperties with typing"] = {
  base: "---\nstatus: draft\n---\nBody.\n",
  line: 3,
  async run() {
    await o.type(" typed");
    await sleep(100);
    await cdp.eval(`${view}.metadataEditor.insertProperties({ extra: "added" }); return true`);
    await sleep(300);
    await cursor(4);
    await o.type(" after");
  },
  expect: "---\nstatus: draft\nextra: added\n---\nBody. typed after\n",
  markers: ["extra: added", " typed", " after"],
};

S["properties UI edits a value with typing"] = {
  base: "---\nstatus: draft\n---\nBody.\n",
  line: 3,
  async run(ctx) {
    await o.type(" typed");
    await sleep(100);
    const sel = `.markdown-source-view .metadata-property[data-property-key="status"] .metadata-property-value [contenteditable], .markdown-source-view .metadata-property[data-property-key="status"] .metadata-property-value input`;
    ctx.note("value element", await cdp.eval(`return ${view}.contentEl.querySelector(${J(sel)})?.outerHTML?.slice(0, 200) ?? null`));
    await cdp.click(sel);
    await sleep(150);
    await selectAllKeys();
    await cdp.send("Input.insertText", { text: "final" });
    await sleep(150);
    await o.key("Tab", { code: "Tab", keyCode: 9 });
    await sleep(500);
    await cursor(3);
    await o.type(" after");
  },
  markers: ["final", " typed", " after"],
  absent: ["draft"],
};

S["rename a linked note"] = {
  base: (ctx) => `See [[T-${ctx.slug}]].\n`,
  async before(ctx) {
    await cdp.eval(`app.vault.setConfig("alwaysUpdateLinks", true); return true`);
    await o.note(`T-${ctx.slug}.md`, "Target.\n");
  },
  async run(ctx) {
    await o.type(" typed");
    await sleep(100);
    await cdp.eval(`await app.fileManager.renameFile(${file(`T-${ctx.slug}.md`)}, ${J(`M-${ctx.slug}.md`)}); return true`);
    await sleep(800);
  },
  expect: (ctx) => `See [[M-${ctx.slug}]]. typed\n`,
  markers: [" typed"],
  absent: ["[[T-"],
};

const templates = async () => {
  await cdp.eval(`const t = app.internalPlugins.getPluginById("templates"); t.instance.options.folder = "Templates"; return true`);
  if (!o.disk("Templates/Tpl.md")) await o.note("Templates/Tpl.md", "From template {{title}}.\n");
  if (!o.disk("Templates/TplFm.md")) await o.note("Templates/TplFm.md", "---\nkind: tpl\n---\nBody from template.\n");
};

S["template insert"] = {
  base: "Tpl.\n\n",
  line: 1,
  before: templates,
  async run() {
    await o.type("x ");
    await cdp.eval(`await app.internalPlugins.getPluginById("templates").instance.insertTemplate(${file("Templates/Tpl.md")}); return true`);
    await sleep(300);
  },
  markers: ["From template", "x "],
};

S["template with frontmatter, typing first"] = {
  base: "Note.\n\n",
  line: 1,
  before: templates,
  async run() {
    await cursor(0);
    await o.type(" typed");
    await cursor(1);
    await cdp.eval(`await app.internalPlugins.getPluginById("templates").instance.insertTemplate(${file("Templates/TplFm.md")}); return true`);
    await sleep(500);
    await o.type("after");
  },
  markers: ["kind: tpl", "Body from template.", " typed", "after"],
};

S["task click live preview"] = {
  base: "- [ ] one\n- [ ] two\n",
  line: 1,
  async run(ctx) {
    ctx.note("checkboxes", await cdp.eval(`return ${view}.contentEl.querySelectorAll(".markdown-source-view .task-list-item-checkbox").length`));
    await cdp.click(".markdown-source-view .task-list-item-checkbox", 0);
    await sleep(300);
  },
  expect: "- [x] one\n- [ ] two\n",
};

S["task click reading view"] = {
  base: "- [ ] one\n- [ ] two\n",
  line: 1,
  async run(ctx) {
    await cdp.eval(`await ${view}.setMode(${view}.previewMode); return true`);
    await sleep(600);
    ctx.note("checkboxes", await cdp.eval(`return ${view}.contentEl.querySelectorAll(".markdown-reading-view .task-list-item-checkbox").length`));
    await cdp.click(".markdown-reading-view .task-list-item-checkbox", 0);
    await sleep(500);
  },
  async after() {
    await cdp.eval(`for (const l of app.workspace.getLeavesOfType("markdown")) if (l.view.getMode() === "preview") await l.view.setMode(l.view.editMode); return true`);
  },
  expect: "- [x] one\n- [ ] two\n",
};

S["task click reading view after typing"] = {
  base: "- [ ] one\n- [ ] two\n",
  line: 1,
  async run(ctx) {
    await o.type(" typed");
    await cdp.eval(`await ${view}.setMode(${view}.previewMode); return true`);
    await sleep(600);
    ctx.note("checkboxes", await cdp.eval(`return ${view}.contentEl.querySelectorAll(".markdown-reading-view .task-list-item-checkbox").length`));
    await cdp.click(".markdown-reading-view .task-list-item-checkbox", 0);
    await sleep(500);
    await cdp.eval(`await ${view}.setMode(${view}.editMode); return true`);
    await sleep(300);
    await cursor(1);
    await o.type(" more");
  },
  expect: "- [x] one\n- [ ] two typed more\n",
  markers: [" typed", " more"],
};

S["mode switches with unsaved typing"] = {
  base: "Mode." + nl,
  async run(ctx) {
    await o.type(" one");
    await ctx.probe("typed one (live preview)");
    await cmd("editor:toggle-source");
    await sleep(200);
    await cursor(0);
    await o.type(" two");
    await ctx.probe("toggled source, typed two");
    await cdp.eval(`await ${view}.setMode(${view}.previewMode); return true`);
    await sleep(400);
    await ctx.probe("in reading view");
    await cdp.eval(`await ${view}.setMode(${view}.editMode); return true`);
    await sleep(300);
    await ctx.probe("back to editing");
    await cursor(0);
    await o.type(" three");
    await ctx.probe("typed three");
    await cmd("editor:toggle-source");
  },
  expect: "Mode. one two three\n",
  markers: [" one", " two", " three"],
};

S["split pane opened with unsaved typing"] = {
  base: "Split." + nl,
  async run(ctx) {
    await o.type(" left");
    await cdp.eval(`const l = app.workspace.getLeaf("split", "vertical"); await l.openFile(${file(ctx.p)});
      app.workspace.setActiveLeaf(l, { focus: true }); const e = l.view.editor; e.setCursor({ line: 0, ch: e.getLine(0).length }); e.cm.focus(); return true`);
    await sleep(200);
    ctx.note("new pane text on open", await o.pane());
    await o.type(" right");
    await sleep(300);
  },
  expect: "Split. left right\n",
  markers: [" left", " right"],
};

S["popout opened with unsaved typing"] = {
  base: "Pop." + nl,
  async run(ctx) {
    await o.type(" left");
    await cdp.eval(`const l = app.workspace.openPopoutLeaf(); await l.openFile(${file(ctx.p)}); app.workspace.setActiveLeaf(l, { focus: true }); return true`);
    await sleep(1200);
    const pop = await popoutClient();
    ctx.note("popout target", !!pop);
    ctx.note("new pane text on open", await o.pane());
    await cdp.eval(`const e = ${ed}; e.setCursor({ line: 0, ch: e.getLine(0).length }); e.cm.focus(); return true`);
    for (const ch of " right") await (pop ?? cdp).send("Input.insertText", { text: ch });
    pop?.close();
    const t = Date.now();
    for (let i = 0; i < 12; i++) {
      await sleep(300);
      ctx.note(`panes +${Date.now() - t}ms`, J(await cdp.eval(`return app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file?.path === ${J(ctx.p)}).map((l) => (l.view.containerEl.win === window ? "main:" : "pop:") + l.view.editor.getValue())`)));
    }
  },
  delay: 10000,
  expect: "Pop. left right\n",
  markers: [" left", " right"],
};

S["rename the open note with typing"] = {
  base: "Rename me." + nl,
  async run(ctx) {
    await o.type(" typed");
    const to = ctx.p.replace(/\.md$/, "-renamed.md");
    await cdp.eval(`await app.fileManager.renameFile(${file(ctx.p)}, ${J(to)}); return true`);
    ctx.paths.push(to);
    await sleep(300);
    await cursor(0);
    await o.type(" more");
  },
  expect: "Rename me. typed more\n",
  markers: [" typed", " more"],
};

S["rename the open note by inline title with typing"] = {
  base: "Rename me." + nl,
  async run(ctx) {
    await o.type(" typed");
    const to = ctx.p.replace(/\.md$/, "-titled");
    await cdp.click(".markdown-source-view .inline-title");
    await sleep(150);
    await selectAllKeys();
    await cdp.send("Input.insertText", { text: to });
    await enter();
    ctx.paths.push(`${to}.md`);
    await sleep(800);
    ctx.note("file now", await cdp.eval(`return ${view}.file?.path`));
    await cursor(0);
    await o.type(" more");
  },
  expect: "Rename me. typed more\n",
  markers: [" typed", " more"],
};

S["outside write, clean pane"] = {
  base: "Out." + nl,
  async run(ctx) {
    o.write(ctx.p, "Out. Outside.\n");
    await eventually(async () => (await o.pane()) === "Out. Outside.\n", 3000);
    await sleep(300);
  },
  expect: "Out. Outside.\n",
  markers: [" Outside."],
};

S["outside write with unsaved typing"] = {
  base: "Top.\n\nBottom.\n",
  line: 0,
  async run(ctx) {
    await o.type(" typed");
    await sleep(200);
    o.write(ctx.p, "Top.\n\nBottom. Outside.\n");
    await eventually(async () => (await o.pane()).includes("Outside"), 3000);
    await sleep(300);
  },
  expect: "Top. typed\n\nBottom. Outside.\n",
  markers: [" typed", " Outside."],
};

S["outside write same line as typing"] = {
  base: "Same line." + nl,
  line: 0,
  async run(ctx) {
    await o.type(" typed");
    await sleep(200);
    o.write(ctx.p, "Same outside line.\n");
    await eventually(async () => (await o.pane()).includes("outside"), 3000);
    await sleep(300);
  },
  markers: ["outside"],
};

S["outside write into empty note with typing"] = {
  base: "",
  line: 0,
  async run(ctx) {
    await o.type("typed");
    await sleep(200);
    o.write(ctx.p, "Outside.\n");
    await eventually(async () => (await o.pane()).includes("Outside"), 3000);
    await sleep(300);
  },
  markers: ["Outside."],
};

S["find and replace all"] = {
  base: "cat one, cat two, cat three." + nl,
  async run(ctx) {
    await cmd("editor:open-search-replace");
    await sleep(300);
    ctx.note(
      "replaced",
      await cdp.eval(`const c = ${view}.containerEl.querySelector(".document-search-container");
        const s = c.querySelector(".document-search-input input"); s.value = "cat"; s.dispatchEvent(new Event("input", { bubbles: true }));
        const r = c.querySelector(".document-replace-input"); r.value = "dog"; r.dispatchEvent(new Event("input", { bubbles: true }));
        const b = [...c.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Replace all"));
        b?.click(); c.querySelector(".document-search-close-button")?.click(); return !!b`),
    );
    await sleep(300);
  },
  expect: "dog one, dog two, dog three.\n",
  absent: ["cat"],
};

S["multi-cursor typing"] = {
  base: "A.\nB.\n",
  async run() {
    await cdp.eval(`const e = ${ed}; e.setSelections([{ anchor: { line: 0, ch: 2 } }, { anchor: { line: 1, ch: 2 } }]); e.cm.focus(); return e.listSelections().length`);
    await o.type("Z");
  },
  expect: "A.Z\nB.Z\n",
};

S["select all and type"] = {
  base: "Replace everything." + nl,
  async run() {
    await cdp.eval(`const e = ${ed}; e.setSelection({ line: 0, ch: 0 }, { line: e.lastLine(), ch: e.getLine(e.lastLine()).length }); e.cm.focus(); return true`);
    await o.type("New");
  },
  expect: "New",
};

S["drop text"] = {
  base: "Drop." + nl,
  async run(ctx) {
    ctx.note(
      "event",
      await cdp.eval(`const cm = ${ed}.cm; const c = cm.coordsAtPos(5); const dt = new DataTransfer(); dt.setData("text/plain", " dropped");
        const ev = new DragEvent("drop", { dataTransfer: dt, clientX: c.right + 1, clientY: (c.top + c.bottom) / 2, bubbles: true, cancelable: true });
        cm.contentDOM.dispatchEvent(ev); return ev.defaultPrevented`),
    );
  },
  expect: "Drop. dropped\n",
  markers: [" dropped"],
};

S["plugin editor.setValue"] = {
  base: "Plugin one.\nPlugin two.\n",
  async run() {
    await cdp.eval(`${ed}.setValue("Plugin one.\\nPlugin two changed.\\n"); return true`);
  },
  expect: "Plugin one.\nPlugin two changed.\n",
  markers: [" changed"],
};

S["navigate away with unsaved typing"] = {
  base: "Away." + nl,
  async run() {
    await o.type(" typed");
    await cdp.eval(`await app.workspace.activeLeaf.openFile(${file("Welcome.md")}); return true`);
    await sleep(500);
  },
  expect: "Away. typed\n",
  markers: [" typed"],
};

S["x2 close pane with unsaved typing"] = {
  base: "Close." + nl,
  async run() {
    await o.type(" typed");
    await cdp.eval(`app.workspace.activeLeaf.detach(); return true`);
    await sleep(500);
  },
  expect: "Close. typed\n",
  markers: [" typed"],
};

S["x2 outside write then undo it"] = {
  base: "Out." + nl,
  async run(ctx) {
    await o.type(" typed");
    await sleep(2600);
    o.write(ctx.p, "Out. typed\nOutside.\n");
    await eventually(async () => (await o.pane()).includes("Outside"), 3000);
    await sleep(300);
    await cdp.eval(`${ed}.undo(); return true`);
    await sleep(200);
    ctx.note("after undo", await o.pane());
    await cursor(0);
    await o.type(" more");
  },
  markers: [" typed", " more"],
};

S["x2 paste image file"] = {
  base: "Image." + nl,
  async run(ctx) {
    ctx.note(
      "event",
      await cdp.eval(`const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
        const dt = new DataTransfer(); dt.items.add(new File([bytes], "dot.png", { type: "image/png" }));
        const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        ${ed}.cm.contentDOM.dispatchEvent(ev); return ev.defaultPrevented`),
    );
    await sleep(1200);
  },
  markers: ["![["],
};

S["x2 live preview table cell edit"] = {
  base: "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n",
  line: 4,
  async run(ctx) {
    const cells = await cdp.eval(`return ${view}.contentEl.querySelectorAll(".markdown-source-view .cm-table-widget td, .markdown-source-view .cm-table-widget th").length`);
    ctx.note("cells", cells);
    if (cells) {
      await cdp.click(".markdown-source-view .cm-table-widget td", 0);
      await sleep(300);
      ctx.note("focused", await cdp.eval(`return document.activeElement?.className ?? null`));
      await o.type("Z");
      await sleep(200);
      ctx.note("pane", await o.pane());
      await escape();
      await sleep(300);
    }
  },
  markers: ["Z"],
};

S["x2 canvas file node edit"] = {
  base: "Canvas." + nl,
  async open(ctx) {
    const c = ctx.p.replace(/\.md$/, ".canvas");
    o.write(c, J({ nodes: [{ id: "n1", type: "file", file: ctx.p, x: 0, y: 0, width: 500, height: 300 }], edges: [] }));
    await sleep(500);
    await cdp.eval(`const l = app.workspace.getLeaf(false); await l.openFile(${file(c)}); app.workspace.setActiveLeaf(l, { focus: true }); return true`);
    await sleep(1000);
    ctx.note(
      "canvas",
      await cdp.eval(`const cv = app.workspace.activeLeaf.view.canvas; const n = cv?.nodes.get("n1");
        if (!n) return { canvas: !!cv, node: false };
        n.startEditing?.(); await new Promise((r) => setTimeout(r, 600));
        const cm = n.child?.editMode?.editor?.cm ?? n.child?.editor?.cm;
        return { canvas: true, node: true, editing: !!n.isEditing, cm: !!cm, text: cm?.state.doc.toString() ?? null }`),
    );
  },
  async run(ctx) {
    await cdp.eval(`const n = app.workspace.activeLeaf.view.canvas.nodes.get("n1"); const cm = n.child?.editMode?.editor?.cm ?? n.child?.editor?.cm;
      cm.focus(); cm.dispatch({ selection: { anchor: 7 } }); return true`);
    await o.type(" typed");
    await sleep(300);
    ctx.note("node text", await cdp.eval(`const n = app.workspace.activeLeaf.view.canvas?.nodes.get("n1"); return (n?.child?.editMode?.editor?.cm ?? n?.child?.editor?.cm)?.state.doc.toString() ?? null`));
    await sleep(2600);
  },
  async after(ctx) {
    await sleep(1500);
    ctx.note("node text after bind", await cdp.eval(`const n = app.workspace.activeLeaf.view.canvas?.nodes.get("n1"); return (n?.child?.editMode?.editor?.cm ?? n?.child?.editor?.cm)?.state.doc.toString() ?? null`));
  },
  expect: "Canvas. typed\n",
  markers: [" typed"],
};

async function cleanup() {
  await cdp.eval(`for (const t of ["markdown", "canvas"]) for (const l of app.workspace.getLeavesOfType(t)) l.detach(); return true`).catch(() => {});
  await sleep(400);
}

async function runOne(name, sc, mode, rep = 0) {
  const slug = `${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}-${mode}${rep ? `-${rep}` : ""}`;
  const p = `sw-${slug}.md`;
  const ctx = { p, mode, slug, paths: [p], probes: [], notes: [] };
  ctx.note = (label, value) => ctx.notes.push([label, value]);
  ctx.probe = async (label) => ctx.probes.push({ label, panes: await inspect(ctx.paths.at(-1)) });
  ctx.bound = () => o.proto(`p.events.some((e) => e.kind === "bind" && ${J(ctx.paths)}.includes(e.path))`);
  ctx.waitBound = () => eventually(() => ctx.bound(), D + 8000);
  await cdp.eval(`${P}.reset(); return true`);
  const t0 = await cdp.eval(`return Date.now()`);
  const r = { name, mode, path: p };
  try {
    await sc.before?.(ctx);
    await o.note(p, typeof sc.base === "function" ? sc.base(ctx) : sc.base);
    await o.setProto({ editLog: process.env.EDIT_LOG !== "0", bindDelay: mode === "unbound" ? (sc.delay ?? D) : 0 });
    await (sc.open ? sc.open(ctx) : o.open(p, sc.line ?? 0));
    if (mode === "bound" && !(await ctx.waitBound())) throw new Error("never bound");
    await ctx.probe("opened");
    await sc.run(ctx);
    r.tEnd = await cdp.eval(`return Date.now()`);
    await ctx.probe("interaction done");
    r.paneAtEnd = await o.panes(ctx.paths.at(-1));
    await o.setProto({ bindDelay: 0 });
    if (mode === "unbound") await ctx.waitBound();
    await sc.after?.(ctx);
    const conv = await o.converged(ctx.paths.at(-1), 15000);
    Object.assign(r, { converged: conv.ok, crdt: conv.crdt, disk: conv.disk, panes: conv.panes });
    const expect = typeof sc.expect === "function" ? sc.expect(ctx) : (sc.expect ?? null);
    r.expect = expect;
    r.matchesExpect = expect === null ? null : conv.crdt === expect;
    r.markersOnce = Object.fromEntries((sc.markers ?? []).map((m) => [m, count(conv.crdt, m)]));
    r.absentOk = (sc.absent ?? []).every((m) => !count(conv.crdt, m));
    r.oldPathGone = ctx.paths.length > 1 ? o.disk(p) === null : null;
  } catch (e) {
    r.error = String(e?.stack ?? e);
    await sc.after?.(ctx).catch(() => {});
  }
  const final = ctx.paths.at(-1);
  r.probes = ctx.probes;
  r.notes = ctx.notes;
  const tx = await o.proto(`p.tx`);
  const mine = tx.filter((t) => ctx.paths.includes(t.path));
  r.tx = [...new Set(mine.map((t) => `${t.bound ? "B" : "U"}:${t.kind}:${t.userEvent}`))];
  r.txOther = [...new Set(tx.filter((t) => !ctx.paths.includes(t.path)).map((t) => `${t.path}:${t.bound ? "B" : "U"}:${t.kind}:${t.userEvent}`))];
  const events = await o.proto(`p.events`);
  r.events = events.filter((e) => ctx.paths.includes(e.path) || e.path == null).map(({ t, ...e }) => ({ dt: t - t0, ...e }));
  r.anomalies = (await o.proto(`p.anomalies`)).map(({ t, ...e }) => ({ dt: t - t0, ...e }));
  r.firstBindDt = r.events.find((e) => e.kind === "bind")?.dt ?? null;
  r.endDt = r.tEnd ? r.tEnd - t0 : null;
  r.paneCreated = r.events.filter((e) => e.kind === "pane-created").length;
  r.authors = await cdp
    .eval(`const f = ${F(final)}; const d = f.ytext.toDelta(); let s = ""; const who = [];
      for (const x of d) { s += x.insert; for (let i = 0; i < x.insert.length; i++) who.push((x.attributes?.pa ?? "none") + "/" + (x.attributes?.pw ?? "-")); }
      const markers = ${J(S[name].markers ?? [])};
      return { runs: d.map((x) => [x.insert, x.attributes?.pa ?? "none", x.attributes?.pw ?? null]),
        markers: Object.fromEntries(markers.map((m) => { const i = s.indexOf(m); return [m, i < 0 ? null : [...new Set(who.slice(i, i + m.length))]]; })) }`)
    .catch((e) => String(e));
  r.log = await cdp.eval(`return app.plugins.plugins["provenance-sync"].log.entries.filter((e) => e.at >= ${t0} && (!e.path || ${J(ctx.paths)}.includes(e.path)) && (e.level !== "debug" || /Merg|typed|failed|stopped/.test(e.message))).map((e) => e.level + " " + e.message.slice(0, 200) + " [" + e.path + "]")`).catch(() => []);
  await cleanup();
  return r;
}

const only = process.argv[2];
const modes = process.argv[3] ? [process.argv[3]] : ["unbound", "bound"];
const out = process.env.OUT ?? "sweep.json";
try {
  for (const [name, sc] of Object.entries(S)) {
    if (only && !new RegExp(only).test(name)) continue;
    for (let rep = 0; rep < Number(process.env.REPEAT ?? 1); rep++) for (const mode of modes) {
      const r = await runOne(name, sc, mode, rep);
      results.push(r);
      writeFileSync(out, J(results, null, 2));
      const ok = r.converged && r.matchesExpect !== false && Object.values(r.markersOnce ?? {}).every((n) => n === 1) && r.absentOk !== false && !r.error;
      console.log(
        `${ok ? "ok  " : "BAD "} [${mode}] ${name}  conv=${r.converged} exp=${r.matchesExpect} markers=${J(r.markersOnce)} anomalies=${J(r.anomalies.map((a) => a.kind))} paneCreated=${r.paneCreated} bindDt=${r.firstBindDt} endDt=${r.endDt}`,
      );
      console.log(`      tx=${J(r.tx)} crdt=${J(r.crdt)}${r.error ? ` error=${r.error.split("\n")[0]}` : ""}`);
    }
  }
} finally {
  writeFileSync(out, J(results, null, 2));
  console.log("work", o.work);
  if (!process.env.KEEP) await o.app.kill();
}
