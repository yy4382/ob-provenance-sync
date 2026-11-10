// End-to-end test against a real Obsidian. Copies test-vault to a temp folder, starts a sync
// server, launches Obsidian with an isolated profile (it never sees your own vaults), drives it
// over the Chrome DevTools protocol and exits non-zero if any check fails.
//
//   pnpm e2e                      (from the repo root; builds everything first)
//   OBSIDIAN_BIN=/path/to/Obsidian KEEP=1 node apps/obsidian/e2e/run.mjs
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eventually, freePort, obsidian, sleep } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const DEVICE_TOKEN = "e2e-device-token-0123456789";
const AGENT_TOKEN = "e2e-agent-token-0123456789";
const work = mkdtempSync(join(tmpdir(), "provenance-e2e-"));
const vault = join(work, "vault");
const profile = join(work, "profile");
const children = [];
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
}

// --- fixtures ---------------------------------------------------------------

cpSync(join(repo, "test-vault"), vault, { recursive: true });
// More notes than the server's default limit on documents waiting for authentication.
mkdirSync(join(vault, "Bulk"));
for (let i = 0; i < 150; i++) writeFileSync(join(vault, "Bulk", `n${i}.md`), `Bulk note ${i}.\n`);
writeFileSync(join(vault, "Projects/Roadmap (conflict 0a0b0c0d).md"), readFileSync(join(vault, "Projects/Roadmap.md")));
writeFileSync(join(vault, "Projects/Roadmap (conflict 1a1b1c1d).md"), readFileSync(join(vault, "Projects/Roadmap.md"), "utf8").replace(/\n/g, "\r\n"));
// Copies whose original is gone, one of them empty: restoring both used to fail on the second.
writeFileSync(join(vault, "Lost (conflict 2a2b2c2d).md"), "");
writeFileSync(join(vault, "Lost (conflict 3a3b3c3d) (conflict 4a4b4c4d).md"), "Survivor.\n");
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
writeFileSync(join(vault, "pixel.png"), pixel);
writeFileSync(join(vault, "pixel (conflict 5a5b5c5d).png"), pixel);
// Obsidian turns its own Sync on by default, and the plugin stays off while another sync is on.
const corePlugins = join(vault, ".obsidian/core-plugins.json");
mkdirSync(dirname(corePlugins), { recursive: true });
writeFileSync(corePlugins, JSON.stringify({ ...(existsSync(corePlugins) ? JSON.parse(readFileSync(corePlugins, "utf8")) : {}), sync: false, templates: true }));
const pluginDir = join(vault, ".obsidian/plugins/provenance-sync");
mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(repo, "apps/obsidian", f), join(pluginDir, f));
// What a version before ob-provenance leaves behind.
for (const f of ["bridge.json", "provenance-mcp.mjs"]) writeFileSync(join(pluginDir, f), "old");

const serverPort = await freePort();
const api = `http://127.0.0.1:${serverPort}/api/vaults/e2e/ops`;
writeFileSync(
  join(work, "server.json"),
  JSON.stringify({
    host: "127.0.0.1",
    port: serverPort,
    dataDir: join(work, "data"),
    tokens: [
      { role: "device", name: "e2e-mac", token: DEVICE_TOKEN },
      { role: "agent", name: "agents", token: AGENT_TOKEN },
    ],
  }),
);
// A plain token here also exercises the move into Obsidian's keychain.
writeFileSync(
  join(pluginDir, "data.json"),
  JSON.stringify({ serverUrl: `http://127.0.0.1:${serverPort}`, token: DEVICE_TOKEN, vaultId: "e2e", humanName: "tester", deviceName: "e2e-mac", enableBridge: true }),
);

// --- processes --------------------------------------------------------------

function startServer() {
  const child = spawn(process.execPath, [join(repo, "apps/server/dist/server.js"), join(work, "server.json")], { stdio: "ignore" });
  children.push(child);
  return child;
}

const instance = await obsidian({ vault, profile });

const engineFile = (path) => `app.plugins.plugins["provenance-sync"].engine.fileAt(${JSON.stringify(path)})`;
/** Distinct authors of the characters of `marker`, which may span several Yjs runs. */
const authorsOf = (cdp, path, marker) =>
  cdp.eval(`const t = ${engineFile(path)}.ytext; const from = t.toJSON().indexOf(${JSON.stringify(marker)}); if (from < 0) return [];
    const to = from + ${marker.length}; const out = new Set(); let pos = 0;
    for (const d of t.toDelta()) { const end = pos + d.insert.length; if (end > from && pos < to) out.add(d.attributes?.pa ?? "none"); pos = end; }
    return [...out]`);

const snapshotOf = (cdp, path) =>
  cdp.eval(`const t = ${engineFile(path)}.ytext;
    return { text: t.toJSON(), attrs: t.toDelta().flatMap(d => Array(d.insert.length).fill(d.attributes ?? {})) }`);

const attributesOf = (snapshot, marker) => {
  const from = snapshot.text.indexOf(marker);
  return from < 0 ? [] : snapshot.attrs.slice(from, from + marker.length);
};

const isHuman = (attrs) => attrs.length > 0 && attrs.every((a) => a.pa === "human:tester" && a.pw === "human-typed" && (a.pn ?? null) === null && a.pd === "e2e-mac" && typeof a.pt === "number" && a.pt > 0);

async function focusPane(cdp, index, line = 0) {
  await cdp.eval(`const l = app.workspace.getLeavesOfType("markdown")[${index}]; app.workspace.setActiveLeaf(l, { focus: true });
    l.view.editor.setCursor({ line: ${line}, ch: 0 }); l.view.editor.cm.focus();`);
  // Obsidian copies edits between panes in a batch once typing pauses; a person never switches faster.
  await sleep(300);
}

/** Opens `path` in the active pane and focuses it; `focusPane` can't, as this pane's index depends on what ran before. */
async function openAndFocus(cdp, path, line = 0) {
  await cdp.eval(`const l = app.workspace.getLeaf(false); await l.openFile(app.vault.getFileByPath(${JSON.stringify(path)})); await new Promise(r => setTimeout(r, 500));
    app.workspace.setActiveLeaf(l, { focus: true }); l.view.editor.setCursor({ line: ${line}, ch: 0 }); l.view.editor.cm.focus();`);
  await sleep(300);
}

/** Selects `marker` in the active editor, runs a reattribution command, fills its modal and returns the notice it shows. */
async function reattributeVia(cdp, command, marker, { why, agent }) {
  await cdp.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove());
    const e = app.workspace.activeEditor.editor; const i = e.getValue().indexOf(${JSON.stringify(marker)});
    e.setSelection(e.offsetToPos(i), e.offsetToPos(i + ${marker.length}));
    app.commands.executeCommandById("provenance-sync:${command}"); return true`);
  if (!(await eventually(() => cdp.eval(`return !!document.querySelector(".modal button.mod-cta")`), 3000))) {
    return `no modal: ${await cdp.eval(`return document.querySelector(".notice")?.innerText`)}`;
  }
  await cdp.eval(`const m = document.querySelector(".modal"); const s = m.querySelector("select");
    if (s && ${JSON.stringify(why ?? null)}) { s.value = ${JSON.stringify(why ?? "")}; s.dispatchEvent(new Event("change")); }
    const input = m.querySelector("input[type=text]");
    if (input && ${JSON.stringify(agent ?? null)}) { input.value = ${JSON.stringify(agent ?? "")}; input.dispatchEvent(new Event("input")); }
    return true`);
  await cdp.shot(command);
  await cdp.eval(`document.querySelector(".modal button.mod-cta").click(); return true`);
  return (await eventually(() => cdp.eval(`return document.querySelector(".notice")?.innerText`))) ?? "no notice";
}

/** Shows `path` in a pane in Live Preview ("source") or reading view ("preview"), with the cursor off its tasks. */
async function openInMode(cdp, leaf, path, mode) {
  if (!(await eventually(() => cdp.eval(`return !!app.vault.getFileByPath(${JSON.stringify(path)})`)))) throw new Error(`Obsidian has not indexed ${path}`);
  await cdp.eval(`const l = ${leaf};
    await l.setViewState({ type: "markdown", state: { file: ${JSON.stringify(path)}, mode: ${JSON.stringify(mode)}, source: false } });
    await new Promise((r) => setTimeout(r, 700)); app.workspace.setActiveLeaf(l, { focus: true });
    if (${JSON.stringify(mode)} === "source") l.view.editor.setCursor({ line: 0, ch: 0 }); return true`);
  await sleep(300);
}

async function clickTask(cdp, view, index = 0) {
  if (!(await eventually(() => cdp.eval(`return app.workspace.activeLeaf.view.contentEl.querySelectorAll(${JSON.stringify(`${view} .task-list-item-checkbox`)}).length > ${index}`)))) {
    const state = await cdp.eval(`const v = app.workspace.activeLeaf.view; return { state: v.getState(), text: v.getViewData(), html: v.contentEl.querySelector(${JSON.stringify(view)})?.innerHTML.slice(-3000) }`);
    throw new Error(`Task checkbox did not render: ${JSON.stringify(state)}`);
  }
  await cdp.click(`${view} .task-list-item-checkbox`, index);
  await sleep(1000);
}

async function opsCall(body) {
  const res = await fetch(api, { method: "POST", headers: { authorization: `Bearer ${AGENT_TOKEN}` }, body: JSON.stringify(body) });
  return res.json();
}

/** The command the plugin's settings hand out for local agents. */
let mcpCommand = null;

async function mcpCall(name, args) {
  const client = new Client({ name: "e2e client", version: "0" });
  await client.connect(new StdioClientTransport({ ...mcpCommand, env: { ...instance.env, ...mcpCommand.env } }));
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

let requests = 0;

/** One op through `obsidian provenance-sync`, the way ob-provenance sends it. */
function cliCall(body) {
  const file = join(work, `request-${++requests}.json`);
  writeFileSync(file, JSON.stringify(body));
  const r = instance.cli("provenance-sync", `request=${file}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { unparsed: r.stdout, stderr: r.stderr, status: r.status };
  }
}

/** Runs the built ob-provenance as an agent would, with this instance's HOME and `obsidian`. */
const ob = (args, opts = {}) =>
  spawnSync(process.execPath, [join(repo, "apps/cli/dist/cli.js"), ...args], { env: { ...instance.env, OB_PROVENANCE_VAULT: "vault" }, cwd: work, encoding: "utf8", timeout: 30000, maxBuffer: 1 << 26, ...opts });

async function openObsidian() {
  const cdp = await instance.open();
  const synced = await eventually(() =>
    cdp.eval(`return document.querySelector(".status-bar")?.innerText.includes("Provenance: synced") && !!${engineFile("Welcome.md")}`),
  );
  if (!synced) {
    const why = await cdp
      .eval(`const p = app.plugins.plugins["provenance-sync"]; return JSON.stringify({ status: document.querySelector(".status-bar")?.innerText, loaded: !!p, log: p?.log.entries.slice(-5).map((e) => e.message) })`)
      .catch((e) => String(e));
    throw new Error(`plugin never reported synced: ${why}`);
  }
  return cdp;
}

// --- scenarios ----------------------------------------------------------------

try {
  const serverProcess = startServer();
  let cdp = await openObsidian();
  check("plugin loads and syncs", true);
  check(
    "legacy token moved into the keychain",
    await cdp.eval(`const p = app.plugins.plugins["provenance-sync"]; return !("token" in p.settings) && !!app.secretStorage.getSecret(p.settings.tokenSecret)`),
  );

  // Renaming these would leave every device's CRDT history behind and make it a fresh device.
  check(
    "local history stays under its database names",
    await cdp.eval(`return (await indexedDB.databases()).some((d) => d.name.startsWith(\`provenance-sync/\${app.appId}/\`))`),
  );

  const plugin = `app.plugins.plugins["provenance-sync"]`;
  await sleep(3000);
  const drops = await cdp.eval(`return ${plugin}.log.entries.filter(e => e.message.startsWith("Disconnected")).length`);
  check("a vault of over 100 notes stays connected", drops === 0, `${drops} disconnects`);

  await cdp.eval(`document.querySelector('.side-dock-ribbon-action[aria-label="Open sync event log"]').click(); return true`);
  const logText = await eventually(() => cdp.eval(`return document.querySelector(".prov-log")?.innerText`));
  check("the ribbon button opens the event log", !!logText?.includes("Status\nsynced") && logText.includes("e2e-mac"), JSON.stringify(logText?.slice(0, 300)));
  await cdp.shot("event-log");

  const engines = await cdp.eval(`const p = ${plugin}; const start = p.startSync.bind(p); const seen = [];
    p.startSync = async () => { await start(); seen.push(p.engine); };
    await Promise.all([p.restartSync(), p.restartSync()]); p.startSync = start;
    return seen.map(e => e === p.engine ? "current" : e.files.size ? "leaked" : "stopped")`);
  check("two overlapping reconnects leave one engine running", JSON.stringify(engines) === '["stopped","current"]', JSON.stringify(engines));
  await eventually(() => cdp.eval(`return document.querySelector(".status-bar")?.innerText.includes("Provenance: synced")`));

  await cdp.eval(`app.commands.executeCommandById("provenance-sync:resolve-conflicts"); return true`);
  const modal = await eventually(() => cdp.eval(`const t = document.querySelector(".modal")?.innerText; return t?.includes("Apply all") ? t : undefined`));
  check("the conflict resolver finds every copy safe to resolve", !!modal?.includes("5 copies: 4 can be resolved safely, 1 wait"), JSON.stringify(modal));
  await cdp.shot("conflicts");
  await cdp.eval(`[...document.querySelectorAll(".modal button")].find(b => b.innerText === "Apply all").click(); return true`);
  const left = await eventually(() => cdp.eval(`const t = document.querySelector(".modal")?.innerText; return t?.includes("no conflict copies") ? t : undefined`), 15000);
  check(
    "apply all resolves copies that add nothing and restores the fullest orphan",
    !!left && !existsSync(join(vault, "Projects/Roadmap (conflict 0a0b0c0d).md")) && readFileSync(join(vault, "Lost.md"), "utf8") === "Survivor.\n" && !existsSync(join(vault, "pixel (conflict 5a5b5c5d).png")),
    JSON.stringify(left),
  );
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true`);

  await cdp.eval(`const f = app.vault.getFileByPath("Welcome.md"); await app.workspace.getLeaf(false).openFile(f);
    await app.workspace.getLeaf("split").openFile(f); await new Promise(r => setTimeout(r, 1000)); return true`);

  await focusPane(cdp, 0);
  await cdp.type("TypedLeft ");
  await focusPane(cdp, 1);
  await cdp.type("TypedRight ");
  await sleep(500);
  for (const m of ["TypedLeft", "TypedRight"]) {
    const authors = await authorsOf(cdp, "Welcome.md", m);
    check(`typing in a split pane is the human's (${m})`, JSON.stringify(authors) === '["human:tester"]', JSON.stringify(authors));
  }
  check("typed text is coloured as human", (await cdp.eval(`return document.querySelectorAll(".prov-human").length`)) > 0);

  await sleep(2500);
  appendFileSync(join(vault, "Welcome.md"), "ExternalEdit line.\n");
  const external = await eventually(async () => {
    const a = await authorsOf(cdp, "Welcome.md", "ExternalEdit");
    return a.length ? a : undefined;
  });
  check("another program's edit to an open file is unknown", JSON.stringify(external) === '["unknown"]', JSON.stringify(external));

  const pluginFiles = (name) => join(vault, ".obsidian/plugins/provenance-sync", name);
  check("old agent files are gone from the plugin folder", !existsSync(pluginFiles("bridge.json")) && !existsSync(pluginFiles("provenance-mcp.mjs")));
  const entry = join(instance.env.HOME, ".config/ob-provenance/vaults/e2evault.json");
  const bin = join(instance.env.HOME, ".local/bin/ob-provenance");
  check("Agent CLI starts off: nothing outside the vault", !existsSync(bin) && !existsSync(entry));
  // Settings open in a window of their own, so this calls what the toggle calls.
  const setAgentCli = (on) => cdp.eval(`await app.setting.pluginTabs.find((t) => t.id === "provenance-sync").setControlValue("agentCli", ${on}); return true`);
  await setAgentCli(true);
  mcpCommand = await eventually(() => cdp.eval(`return app.plugins.plugins["provenance-sync"].mcpCommand()`));
  check("settings offer a local MCP command", mcpCommand?.args[0] === bin && mcpCommand.args.join(" ").endsWith("--vault e2evault mcp") && !JSON.stringify(mcpCommand).includes(DEVICE_TOKEN), JSON.stringify(mcpCommand));
  await eventually(async () => existsSync(entry));
  check("the installed CLI can run and its entry is private", (statSync(bin).mode & 0o777) === 0o755 && (statSync(entry).mode & 0o777) === 0o600, JSON.stringify([statSync(bin).mode, statSync(entry).mode]));
  check("the entry names this vault and its server", JSON.parse(readFileSync(entry, "utf8")).server?.token === DEVICE_TOKEN);
  const edit = await mcpCall("append_to_file", { path: "Projects/Roadmap.md", text: "- AgentBridge line.\n", why: "agent", note: "e2e note" });
  check("local MCP edits through the plugin", !edit.isError, JSON.stringify(edit.content));
  const links = await mcpCall("get_backlinks", { path: "Welcome.md" });
  check("full mode answers backlinks", !links.isError && links.content[0].text.includes("Projects/Roadmap.md"), JSON.stringify(links.content));

  await mcpCall("create_file", { path: "Target.md", content: "Target text.\n", why: "agent" });
  await mcpCall("create_file", { path: "Linker.md", content: "See [[Target]] here.\n", why: "agent" });
  await eventually(() => cdp.eval(`return app.metadataCache.resolvedLinks["Linker.md"]?.["Target.md"]`));
  const renameStart = Date.now();
  const renamed = await mcpCall("rename_file", { from: "Target.md", to: "McpMoved/Deep/Target2.md" });
  check(
    "renaming a linked note reports the link dialog instead of waiting on it",
    !renamed.isError && renamed.content[0].text.includes("asking the human") && Date.now() - renameStart < 10000,
    JSON.stringify(renamed.content),
  );
  const moved = await eventually(async () => {
    const r = await mcpCall("read_file", { path: "McpMoved/Deep/Target2.md", provenance: true });
    return r.isError ? undefined : r.content[0].text;
  });
  check("a rename into a new folder keeps attribution", moved?.startsWith("[agent agent:"), moved);
  await cdp.eval(`[...document.querySelectorAll(".modal button")].find((b) => /Just once/.test(b.innerText)).click(); return true`);
  const relinked = await eventually(async () => {
    const r = await mcpCall("read_file", { path: "Linker.md" });
    return r.content[0].text.includes("Target2") ? r.content[0].text : undefined;
  });
  check("the human's answer updates the link", !!relinked);
  const taskNote = "Intro.\n\n- [ ] Live task\n\n> [!note] Heading\n> Agent line.\n> - [ ] Callout task\n";
  const agrees = (path) => eventually(async () => (await cdp.eval(`return ${engineFile(path)}?.ytext.toJSON()`)) === readFileSync(join(vault, path), "utf8"));
  const whole = async (path) => authorsOf(cdp, path, await cdp.eval(`return ${engineFile(path)}.ytext.toJSON()`));
  await mcpCall("create_file", { path: "Tasks.md", content: taskNote, why: "agent" });
  await eventually(async () => existsSync(join(vault, "Tasks.md")));
  await openInMode(cdp, `app.workspace.getLeaf("tab")`, "Tasks.md", "source");
  await clickTask(cdp, ".markdown-source-view", 0);
  check("a click on a task in Live Preview is the human's", (await authorsOf(cdp, "Tasks.md", "x")).join() === "human:tester", JSON.stringify(await authorsOf(cdp, "Tasks.md", "x")));
  await clickTask(cdp, ".markdown-source-view", 1);
  const calloutAuthors = await authorsOf(cdp, "Tasks.md", "Agent line");
  check("a click on a task in a callout leaves the callout's text with its author", calloutAuthors.length === 1 && calloutAuthors[0].startsWith("agent:"), JSON.stringify(calloutAuthors));
  check("clicking tasks adds no unknown text", !(await whole("Tasks.md")).includes("unknown"), JSON.stringify(await whole("Tasks.md")));
  await agrees("Tasks.md");

  await openInMode(cdp, "app.workspace.activeLeaf", "Tasks.md", "preview");
  await clickTask(cdp, ".markdown-reading-view", 0);
  const unticked = await agrees("Tasks.md");
  check("unticking a task in reading view reaches the note", unticked && (await cdp.eval(`return ${engineFile("Tasks.md")}.ytext.toJSON()`)).includes("- [ ] Live task"), readFileSync(join(vault, "Tasks.md"), "utf8"));
  await clickTask(cdp, ".markdown-reading-view", 0);
  check("ticking a task in reading view reaches the note", await agrees("Tasks.md"), readFileSync(join(vault, "Tasks.md"), "utf8"));
  check("a click on a task in reading view is the human's", !(await whole("Tasks.md")).includes("unknown"), JSON.stringify(await whole("Tasks.md")));

  await openInMode(cdp, "app.workspace.activeLeaf", "Tasks.md", "source");
  await cdp.eval(`app.workspace.activeEditor.editor.replaceRange("y", { line: 0, ch: 0 }); return true`);
  await sleep(500);
  check("another plugin's Editor.replaceRange edit is the human's", (await authorsOf(cdp, "Tasks.md", "y")).join() === "human:tester", JSON.stringify(await authorsOf(cdp, "Tasks.md", "y")));
  await cdp.eval(`app.workspace.activeLeaf.detach(); return true`);

  // Obsidian's save waits two seconds, so it runs after the switch, from reading view. Taken for
  // another plugin's write, it would be merged from disk and double the edit.
  await openInMode(cdp, `app.workspace.getLeaf("tab")`, "Tasks.md", "source");
  await cdp.eval(`app.workspace.activeEditor.editor.replaceRange("Before reading. ", { line: 0, ch: 0 }); return true`);
  await openInMode(cdp, "app.workspace.activeLeaf", "Tasks.md", "preview");
  await sleep(2500);
  check("an edit saved after switching to reading view is saved once", !!(await agrees("Tasks.md")) &&
    readFileSync(join(vault, "Tasks.md"), "utf8").split("Before reading.").length === 2, readFileSync(join(vault, "Tasks.md"), "utf8"));
  await cdp.eval(`app.workspace.activeLeaf.detach(); return true`);

  const localApiSaved = new Map();
  const rewritePath = "LocalApi-rewrite.md";
  const completedTask = "- [x] Pack the spare cable.\n";
  const rewriteBase = `# Workshop\n\n- [ ] Inspect the telescope.\n${completedTask}\nReference remains.\n`;
  const handwritten = "\nReviewed by hand.\n";
  const migratedTask = "\n## Migrated tasks\n- [ ] Water the fern.\n";
  const seeded = await mcpCall("create_file", { path: rewritePath, content: rewriteBase, why: "agent", note: "Synthetic task migration fixture" });
  check("the task migration fixture is created by the agent", !seeded.isError, JSON.stringify(seeded.content));
  await eventually(async () => existsSync(join(vault, rewritePath)));
  await openInMode(cdp, `app.workspace.getLeaf("tab")`, rewritePath, "source");
  const agentSeed = await snapshotOf(cdp, rewritePath);
  check("Vault creation inside an explicit agent write keeps its identity and note", agentSeed.text === rewriteBase && agentSeed.attrs.every((a) => a.pa === "agent:e2e-client" && a.pw === "agent" && a.pn === "Synthetic task migration fixture"), JSON.stringify(agentSeed));
  await cdp.eval(`const e = app.workspace.activeEditor.editor; e.replaceRange(${JSON.stringify(handwritten)}, e.offsetToPos(e.getValue().length)); return true`);
  check("the mixed rewrite fixture is saved before migration", !!(await agrees(rewritePath)));
  const beforeRewrite = await snapshotOf(cdp, rewritePath);
  check("the rewrite fixture includes human text", isHuman(attributesOf(beforeRewrite, handwritten)), JSON.stringify(beforeRewrite));
  const rewritten = rewriteBase.replace(completedTask, "") + handwritten + migratedTask;
  await cdp.eval(`app.workspace.activeEditor.editor.setValue(${JSON.stringify(rewritten)}); return true`);
  check("Editor.setValue saves the migrated tasks", !!(await eventually(async () => readFileSync(join(vault, rewritePath), "utf8") === rewritten && (await snapshotOf(cdp, rewritePath)).text === rewritten)));
  const afterRewrite = await snapshotOf(cdp, rewritePath);
  for (const retained of [rewriteBase.slice(0, rewriteBase.indexOf(completedTask)), "\nReference remains.\n" + handwritten]) {
    const attrs = attributesOf(afterRewrite, retained);
    check("Editor.setValue keeps every attribute on unchanged text", attrs.length === retained.length && isDeepStrictEqual(attrs, attributesOf(beforeRewrite, retained)), JSON.stringify({ retained, attrs }));
  }
  check("Editor.setValue attributes inserted tasks to the human", isHuman(attributesOf(afterRewrite, migratedTask)), JSON.stringify(attributesOf(afterRewrite, migratedTask)));
  const rewriteUpdates = await cdp.eval(`const t = ${engineFile(rewritePath)}.ytext; let updates = 0;
    const record = () => updates++; t.doc.on("update", record);
    try {
      const e = app.workspace.activeEditor.editor; e.setValue(e.getValue());
      await new Promise(r => setTimeout(r, 1000)); return updates;
    } finally { t.doc.off("update", record); }`);
  check("an identical Editor.setValue produces no provenance mutation", rewriteUpdates === 0 && isDeepStrictEqual(await snapshotOf(cdp, rewritePath), afterRewrite), `${rewriteUpdates} updates`);
  const queuedSave = await cdp.eval(`const view = app.workspace.activeLeaf.view, adapter = app.vault.adapter;
    const file = ${engineFile(rewritePath)};
    const previous = adapter.promise;
    let release;
    adapter.promise = new Promise((resolve) => { release = resolve; });
    try {
      view.editor.setValue(view.editor.getValue() + "First queued edit.\\n");
      const first = view.save();
      file.doc.transact(() => file.ytext.insert(file.ytext.length, "Queued agent edit.\\n", ${JSON.stringify(agentSeed.attrs[0])}));
      const second = view.save();
      view.editor.setValue(view.editor.getValue() + "Last queued edit.\\n");
      const expected = file.ytext.toDelta();
      adapter.promise = previous;
      release();
      await Promise.all([first, second]);
      await view.save();
      return expected;
    } finally { adapter.promise = previous; release(); }`);
  check("queued editor saves converge after intervening human and agent edits", !!(await agrees(rewritePath)));
  const afterQueuedSave = await snapshotOf(cdp, rewritePath);
  check("queued saves preserve the exact text and attributes without replaying edits",
    isDeepStrictEqual(await cdp.eval(`return ${engineFile(rewritePath)}.ytext.toDelta()`), queuedSave), JSON.stringify(afterQueuedSave));
  localApiSaved.set(rewritePath, afterQueuedSave);
  await cdp.eval(`app.workspace.activeLeaf.detach(); return true`);

  for (const { name, edit, identical } of [
    { name: "setValue", edit: "e.setValue(next)" },
    { name: "replaceRange", edit: "e.replaceRange(next, { line: 0, ch: 0 }, e.offsetToPos(e.getValue().length))" },
    { name: "replaceRange-custom-origin", edit: 'e.replaceRange(next, { line: 0, ch: 0 }, e.offsetToPos(e.getValue().length), "plugin.task-migration")' },
    { name: "transaction", edit: "e.transaction({ changes: [{ from: { line: 0, ch: 0 }, to: e.offsetToPos(e.getValue().length), text: next }] })" },
    { name: "transaction-custom-origin", edit: 'e.transaction({ changes: [{ from: { line: 0, ch: 0 }, to: e.offsetToPos(e.getValue().length), text: next }] }, "plugin.task-migration")' },
    { name: "identical-setValue", edit: "e.setValue(e.getValue())", identical: true },
  ]) {
    const path = `LocalApi-editor-${name}.md`;
    const base = "Agent reference.\n- [ ] Inspect the sundial.\n";
    const next = identical ? base : base.replace("[ ]", "[x]");
    const changedAt = identical ? -1 : base.indexOf("[ ]") + 1;
    const fixture = await mcpCall("create_file", { path, content: base, why: "agent", note: "Retain every unchanged attribute" });
    check(`Editor ${name} fixture is created`, !fixture.isError, JSON.stringify(fixture.content));
    await eventually(async () => existsSync(join(vault, path)) && (await snapshotOf(cdp, path)).text === base);
    await openInMode(cdp, `app.workspace.getLeaf("tab")`, path, "source");
    await cdp.eval(`const t = ${engineFile(path)}.ytext; t.doc.transact(() => t.format(0, t.length, { customReview: "approved" })); return true`);
    const before = await snapshotOf(cdp, path);
    const history = () => cdp.eval(`const engine = ${plugin}.engine, file = ${engineFile(path)};
      const { entries } = await engine.week(Math.floor(Date.now() / 604800000));
      return entries.filter(e => e.t === "edit" && e.id === file.id).map(e => ({ by: e.by, removes: e.removes }))`);
    const beforeHistory = identical ? await history() : null;
    for (const [step, action, expected] of [
      ["replace", edit, next],
      ["undo", "e.undo()", base],
      ["redo", "e.redo()", next],
    ]) {
      await cdp.eval(`const e = app.workspace.activeEditor.editor, next = ${JSON.stringify(next)}; ${action};
        await app.workspace.activeLeaf.view.save(); return true`);
      check(`Editor ${name} ${step} reaches the editor, CRDT and disk`, !!(await eventually(async () =>
        readFileSync(join(vault, path), "utf8") === expected &&
        (await snapshotOf(cdp, path)).text === expected &&
        await cdp.eval(`return app.workspace.activeEditor.editor.getValue() === ${JSON.stringify(expected)}`))));
      const after = await snapshotOf(cdp, path);
      check(`Editor ${name} ${step} preserves every unchanged attribute`,
        isDeepStrictEqual(after.attrs.filter((_, i) => i !== changedAt), before.attrs.filter((_, i) => i !== changedAt)), JSON.stringify(after));
      if (!identical) {
        check(`Editor ${name} ${step} attributes the changed checkbox to the human`,
          isHuman(after.attrs.slice(changedAt, changedAt + 1)), JSON.stringify(after.attrs[changedAt]));
      } else {
        check(`Editor ${name} ${step} adds no journal edit`, isDeepStrictEqual(await history(), beforeHistory));
      }
    }
    localApiSaved.set(path, await snapshotOf(cdp, path));
    await cdp.eval(`app.workspace.activeLeaf.detach(); return true`);
  }

  const deletionPath = "LocalApi-editor-deletion.md";
  const deletionBase = "Agent reference.\nRemove this line.\nKeep this line.\n";
  const deletionNext = deletionBase.replace("Remove this line.\n", "");
  const deletionFixture = await mcpCall("create_file", { path: deletionPath, content: deletionBase, why: "agent", note: "Retain the surviving text" });
  check("the Editor deletion fixture is created", !deletionFixture.isError, JSON.stringify(deletionFixture.content));
  await eventually(async () => existsSync(join(vault, deletionPath)) && (await snapshotOf(cdp, deletionPath)).text === deletionBase);
  await openInMode(cdp, `app.workspace.getLeaf("tab")`, deletionPath, "source");
  const beforeDeletion = await snapshotOf(cdp, deletionPath);
  await cdp.eval(`const e = app.workspace.activeEditor.editor;
    e.replaceRange(${JSON.stringify(deletionNext)}, { line: 0, ch: 0 }, e.offsetToPos(e.getValue().length), "plugin.remove-line");
    await app.workspace.activeLeaf.view.save(); return true`);
  check("a custom-origin Editor deletion reaches disk and CRDT", !!(await eventually(async () =>
    readFileSync(join(vault, deletionPath), "utf8") === deletionNext && (await snapshotOf(cdp, deletionPath)).text === deletionNext)));
  const afterDeletion = await snapshotOf(cdp, deletionPath);
  for (const retained of ["Agent reference.\n", "Keep this line.\n"]) {
    check("a custom-origin Editor deletion keeps all surviving attributes",
      isDeepStrictEqual(attributesOf(afterDeletion, retained), attributesOf(beforeDeletion, retained)), JSON.stringify(afterDeletion));
  }
  const deletionHistory = await cdp.eval(`const engine = ${plugin}.engine, file = ${engineFile(deletionPath)};
    const { entries } = await engine.week(Math.floor(Date.now() / 604800000));
    return entries.filter(e => e.t === "edit" && e.id === file.id).map(e => ({ by: e.by, removes: e.removes }))`);
  check("a custom-origin Editor deletion records the human actor",
    deletionHistory.some(e => e.by === "human:tester" && e.removes), JSON.stringify(deletionHistory));
  localApiSaved.set(deletionPath, afterDeletion);
  await cdp.eval(`app.workspace.activeLeaf.detach(); return true`);

  const localCreatePath = "LocalApi-created.md";
  const localCreatedText = "A plugin created this note.\n";
  await cdp.eval(`await app.vault.create(${JSON.stringify(localCreatePath)}, ${JSON.stringify(localCreatedText)}); return true`);
  const localCreated = await eventually(async () => {
    const snapshot = await snapshotOf(cdp, localCreatePath);
    return snapshot.text === localCreatedText ? snapshot : undefined;
  });
  check("Vault.create attributes a plugin's new note to the human", !!localCreated && isHuman(localCreated.attrs), JSON.stringify(localCreated));
  if (localCreated) localApiSaved.set(localCreatePath, localCreated);

  const normalizedCreatePath = "Folder/note.md";
  const normalizedCreatedText = "A plugin created this note through a noncanonical path.\n";
  const createdPath = await cdp.eval(`await app.vault.createFolder("Folder");
    const f = await app.vault.create("Folder//note.md", ${JSON.stringify(normalizedCreatedText)}); return f.path`);
  check("Vault.create returns the canonical path", createdPath === normalizedCreatePath, createdPath);
  const normalizedCreated = await eventually(async () => {
    const snapshot = await snapshotOf(cdp, normalizedCreatePath);
    return existsSync(join(vault, normalizedCreatePath)) && readFileSync(join(vault, normalizedCreatePath), "utf8") === normalizedCreatedText && snapshot.text === normalizedCreatedText ? snapshot : undefined;
  });
  check("Vault.create with a noncanonical path attributes the canonical note to the human", !!normalizedCreated && isHuman(normalizedCreated.attrs), JSON.stringify(normalizedCreated));
  if (normalizedCreated) localApiSaved.set(normalizedCreatePath, normalizedCreated);

  for (const mode of ["open", "closed"]) {
    for (const method of ["process", "modify", "append"]) {
      const path = `LocalApi-${mode}-${method}.md`;
      const base = "Agent reference.\n\n- [ ] Inspect the sundial.\n";
      const added = `\nPlugin ${method} addition.\n`;
      const content = (method === "append" ? base : base.replace("[ ]", "[x]")) + added;
      const fixture = await mcpCall("create_file", { path, content: base, why: "agent", note: "Retain the original provenance" });
      check(`${mode} Vault.${method} fixture is created`, !fixture.isError, JSON.stringify(fixture.content));
      await eventually(async () => existsSync(join(vault, path)) && (await snapshotOf(cdp, path)).text === base);
      if (mode === "open") await openInMode(cdp, `app.workspace.getLeaf("tab")`, path, "source");
      const before = await snapshotOf(cdp, path);
      const changedAt = method === "append" ? -1 : base.indexOf("[ ]") + 1;
      const operation = {
        process: `await app.vault.process(f, text => text.replace("[ ]", "[x]") + ${JSON.stringify(added)})`,
        modify: `await app.vault.modify(f, ${JSON.stringify(content)})`,
        append: `await app.vault.append(f, ${JSON.stringify(added)})`,
      }[method];
      await cdp.eval(`const f = app.vault.getFileByPath(${JSON.stringify(path)}); ${operation}; return true`);
      check(`Vault.${method} saves the ${mode} note`, !!(await eventually(async () => readFileSync(join(vault, path), "utf8") === content && (await snapshotOf(cdp, path)).text === content)));
      if (mode === "open") {
        check(`Vault.${method} reaches the open editor`, !!(await eventually(() => cdp.eval(`return app.workspace.activeEditor.editor.getValue() === ${JSON.stringify(content)}`))));
      }
      const after = await snapshotOf(cdp, path);
      check(`Vault.${method} keeps unchanged attributes in the ${mode} note`, isDeepStrictEqual(after.attrs.slice(0, base.length).filter((_, i) => i !== changedAt), before.attrs.filter((_, i) => i !== changedAt)), JSON.stringify(after));
      const inserted = attributesOf(after, added).concat(changedAt < 0 ? [] : after.attrs.slice(changedAt, changedAt + 1));
      check(`Vault.${method} attributes changes in the ${mode} note to the human`, inserted.length === added.length + (changedAt < 0 ? 0 : 1) && isHuman(inserted), JSON.stringify(inserted));
      if (method === "modify" || method === "append") {
        const noOp = {
          modify: `await app.vault.modify(f, ${JSON.stringify(content)})`,
          append: `await app.vault.append(f, "")`,
        }[method];
        await cdp.eval(`const f = app.vault.getFileByPath(${JSON.stringify(path)}); ${noOp}; return true`);
        await sleep(1000);
        const afterNoOp = await snapshotOf(cdp, path);
        check(`no-op Vault.${method} preserves text and every attribute in the ${mode} note`, readFileSync(join(vault, path), "utf8") === content && isDeepStrictEqual(afterNoOp, after), JSON.stringify(afterNoOp));
      }
      localApiSaved.set(path, after);
      if (mode === "open") await cdp.eval(`app.workspace.activeLeaf.detach(); return true`);
    }
  }

  const concurrentPath = "LocalApi-closed-modify.md";
  const beforeConcurrent = await snapshotOf(cdp, concurrentPath);
  await cdp.eval(`const file = app.vault.getFileByPath(${JSON.stringify(concurrentPath)});
    await Promise.all([
      app.vault.modify(file, ${JSON.stringify(beforeConcurrent.text)}),
      app.vault.modify(file, ${JSON.stringify(beforeConcurrent.text + "Concurrent addition.\n")})
    ]); return true`);
  check("a no-op Vault.modify does not undo a queued change", !!(await agrees(concurrentPath)));
  const afterNoOpOverlap = await snapshotOf(cdp, concurrentPath);
  check("a queued change after no-op Vault.modify keeps human attribution",
    isHuman(attributesOf(afterNoOpOverlap, "Concurrent addition.\n")) &&
    isDeepStrictEqual(afterNoOpOverlap.attrs.slice(0, beforeConcurrent.text.length), beforeConcurrent.attrs), JSON.stringify(afterNoOpOverlap));
  await cdp.eval(`await app.vault.modify(app.vault.getFileByPath(${JSON.stringify(concurrentPath)}), ${JSON.stringify(beforeConcurrent.text)}); return true`);
  await cdp.eval(`const file = app.vault.getFileByPath(${JSON.stringify(concurrentPath)});
    await Promise.all([
      app.vault.modify(file, ${JSON.stringify(beforeConcurrent.text + "Reverted addition.\n")}),
      app.vault.modify(file, ${JSON.stringify(beforeConcurrent.text)})
    ]); return true`);
  check("overlapping Vault.modify calls keep a deliberate revert",
    !!(await agrees(concurrentPath)) && isDeepStrictEqual(await snapshotOf(cdp, concurrentPath), beforeConcurrent));
  await cdp.eval(`const file = app.vault.getFileByPath(${JSON.stringify(concurrentPath)});
    const engine = app.plugins.plugins["provenance-sync"].engine;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const queued = engine.enqueue(() => held);
    try {
      await app.vault.adapter.write(file.path, ${JSON.stringify(beforeConcurrent.text + "External addition.\n")});
      await app.vault.modify(file, ${JSON.stringify(beforeConcurrent.text + "External addition.\nLocal addition.\n")});
    } finally { release(); await queued; }
    return true`);
  check("Vault.modify reconciles an external edit before its watcher finishes", !!(await agrees(concurrentPath)));
  const afterConcurrent = await snapshotOf(cdp, concurrentPath);
  // The outside edit stays unknown. The plugin's addition is the human's if the engine merged
  // the outside edit before the plugin's write landed; if it read both at once it can't tell
  // them apart, and both stay unknown. Which happens depends on when Obsidian's watcher fires.
  const localAddition = attributesOf(afterConcurrent, "Local addition.\n");
  check("Vault.modify over an unseen outside edit keeps both additions, the outside one unknown",
    afterConcurrent.text === beforeConcurrent.text + "External addition.\nLocal addition.\n" &&
    attributesOf(afterConcurrent, "External addition.\n").every((a) => a.pa === "unknown") &&
    (localAddition.every((a) => a.pa === "unknown") || isHuman(localAddition)) &&
    isDeepStrictEqual(afterConcurrent.attrs.slice(0, beforeConcurrent.text.length), beforeConcurrent.attrs), JSON.stringify(afterConcurrent));
  localApiSaved.set(concurrentPath, afterConcurrent);

  const setDaily = (options) => cdp.eval(`app.internalPlugins.getEnabledPluginById("daily-notes").options = ${JSON.stringify(options)}; return true`);
  const daily = await mcpCall("get_daily_note", {});
  const [dailyPath, dailyPending] = daily.content[0].text.split("\n");
  check("get_daily_note reports a missing note without creating it", !daily.isError && dailyPending === "(not created yet)" && !existsSync(join(vault, dailyPath)), JSON.stringify(daily.content));
  await setDaily({ template: "NoSuchTemplate" });
  const noTemplate = await mcpCall("create_daily_note", {});
  check("create_daily_note fails on a missing template", noTemplate.isError && noTemplate.content[0].text.includes("template") && !existsSync(join(vault, dailyPath)), JSON.stringify(noTemplate.content));
  await mcpCall("create_file", { path: "DailyTemplate.md", content: "Template line.\n", why: "agent" });
  await eventually(async () => existsSync(join(vault, "DailyTemplate.md")));
  await setDaily({ template: "DailyTemplate" });
  const created = await mcpCall("create_daily_note", {});
  const dailyWrite = await mcpCall("append_to_file", { path: dailyPath, text: "AgentDaily line.\n", why: "agent" });
  check("create_daily_note returns a note the agent can write at once", !created.isError && created.content[0].text === dailyPath && !dailyWrite.isError, JSON.stringify([created.content, dailyWrite.content]));
  const dailyAuthors = await mcpCall("read_file", { path: dailyPath, provenance: true });
  check("the daily template is human and the agent's text is the agent's", /^\[human human:tester\] Template line\.\n\[agent agent:e2e-client\] AgentDaily line\./.test(dailyAuthors.content[0].text), dailyAuthors.content[0].text);
  await mcpCall("create_daily_note", {});
  const dailyAgain = await mcpCall("read_file", { path: dailyPath });
  check("create_daily_note leaves an existing note alone", dailyAgain.content[0].text === "Template line.\nAgentDaily line.\n", dailyAgain.content[0].text);
  check("get_daily_note prints the bare path once the note exists", (await mcpCall("get_daily_note", {})).content[0].text === dailyPath);
  await setDaily({ folder: "NoSuchFolder" });
  const noFolder = await mcpCall("get_daily_note", {});
  await setDaily({});
  check("get_daily_note names a missing folder", noFolder.isError && noFolder.content[0].text.includes("NoSuchFolder"), JSON.stringify(noFolder.content));

  const by = { agent: "agent:cli-e2e", why: "agent" };
  const strings = [`quote"s and 'single'`, "line1\nline2\r\nline3", "tab\there", "back\\slash \\n literal", "emoji 🧠 中文 العربية", "a=b=c", "control\x01\x02\x1f", "--looks-like-flag", "path/that.md", "", "  spaces  ", "obsidian://open", "\u2028sep\u2029"];
  const garbled = strings.filter((content, i) => {
    const path = `Cli/string${i}.md`;
    return cliCall({ op: "create", path, content, by }).ok !== true || cliCall({ op: "read", path }).result?.content !== content;
  });
  check("obsidian provenance-sync keeps every string intact", garbled.length === 0, JSON.stringify(garbled));
  cliCall({ op: "create", path: "Cli/ops.md", content: "First.", by });
  const edited = cliCall({ op: "edit", path: "Cli/ops.md", oldString: "First", newString: "Second", by });
  const appended = cliCall({ op: "append", path: "Cli/ops.md", text: " Third.", by });
  const provenance = cliCall({ op: "read", path: "Cli/ops.md", provenance: true });
  check(
    "writes through the handler are attributed to the agent",
    edited.result?.replaced === 1 && appended.ok && provenance.result?.content === "Second. Third." && provenance.result.sentences.every((s) => s.authors.join() === "agent:cli-e2e"),
    JSON.stringify(provenance),
  );
  check("the handler lists", cliCall({ op: "list", prefix: "Cli/" }).result?.files.includes("Cli/ops.md"));
  check("the handler searches", cliCall({ op: "search", query: "AgentBridge" }).result?.paths.includes("Projects/Roadmap.md"));
  check("the handler follows links", cliCall({ op: "links", path: "Linker.md" }).result?.paths.includes("McpMoved/Deep/Target2.md"));
  check("the handler follows backlinks", cliCall({ op: "backlinks", path: "McpMoved/Deep/Target2.md" }).result?.paths.includes("Linker.md"));
  check("the handler finds the daily note", cliCall({ op: "daily" }).result?.path === dailyPath);
  await eventually(async () => existsSync(join(vault, "Cli/ops.md")));
  const cliRenamed = cliCall({ op: "rename", from: "Cli/ops.md", to: "Cli/renamed.md" });
  await eventually(async () => existsSync(join(vault, "Cli/renamed.md")));
  check("the handler renames and deletes", cliRenamed.ok === true && cliCall({ op: "delete", path: "Cli/renamed.md" }).ok === true, JSON.stringify(cliRenamed));
  const invalid = cliCall({ op: "read", path: "../outside.md" });
  check("the handler rejects a bad request as an op response", invalid.ok === false && invalid.code === "invalid", JSON.stringify(invalid));

  check("ob-provenance lists the registered vault", ob(["vaults"]).stdout.startsWith("vault\t"));
  check("ob-provenance reaches Obsidian", ob(["status"]).stdout.includes("Obsidian: reachable"), JSON.stringify(ob(["status"])));
  const written = ob(["create", "--path", "Cli/shell.md", "--content", "From the shell.", "--why", "agent", "--agent", "shell-agent"]);
  check("ob-provenance writes as the agent it names", written.status === 0 && ob(["read", "--path", "Cli/shell.md", "--provenance"]).stdout === "[agent agent:shell-agent] From the shell.\n", JSON.stringify(written));
  const anonymous = ob(["append", "--path", "Cli/shell.md", "--text", "x", "--why", "agent"]);
  check("ob-provenance refuses a write with no identity", anonymous.status === 2 && anonymous.stderr.includes("--agent <name>"), JSON.stringify(anonymous));
  const piped = "two lines\nwith \"quotes\" and a trailing newline\n";
  ob(["create", "--path", "Cli/piped.md", "--why", "agent", "--agent", "shell-agent", "--stdin", "content"], { input: piped });
  check("ob-provenance takes a field from stdin", ob(["read", "--path", "Cli/piped.md"]).stdout === piped);
  const unknownVault = ob(["--vault", "Nope", "list"]);
  check("ob-provenance names the vaults it knows", unknownVault.status === 2 && unknownVault.stderr.includes("vault (id e2evault"), JSON.stringify(unknownVault));
  const twoVaults = ob(["--vault", "vault", "list", "--vault", "other"]);
  check("ob-provenance refuses two different vaults in one call", twoVaults.status === 2 && twoVaults.stderr.includes("given twice"), JSON.stringify(twoVaults));
  const mcpUnnamed = ob(["mcp"], { env: instance.env });
  check("ob-provenance mcp won't start without a vault", mcpUnnamed.status === 2 && mcpUnnamed.stderr.includes("--vault <name>"), JSON.stringify(mcpUnnamed));
  for (const path of ["Meeting: Q3.md", ".hidden/note.md", "welcome.md", "Welcome.md/x.md"]) {
    const refused = ob(["create", "--path", path, "--content", "x", "--why", "agent", "--agent", "shell-agent"]);
    check(`ob-provenance refuses a note that could never reach the disk: ${path}`, refused.status !== 0 && !ob(["read", "--path", path]).stdout, JSON.stringify(refused));
  }
  const closedPipe = spawnSync("sh", ["-c", `"${process.execPath}" "${join(repo, "apps/cli/dist/cli.js")}" --help | true`], { encoding: "utf8" });
  check("ob-provenance stays quiet when the reader of its output goes away", closedPipe.stderr === "", closedPipe.stderr);
  check("ob-provenance prints an op error and exits 1", ob(["read", "--path", "Cli/missing.md"]).status === 1);
  check("ob-provenance searches", ob(["search", "--query", "AgentBridge"]).stdout.includes("Projects/Roadmap.md"));
  check("a read ignores a bad agent name", ob(["--vault", "vault", "read", "--path", "Cli/shell.md"], { env: { ...instance.env, OB_PROVENANCE_AGENT: "Claude Code" } }).status === 0);

  ob(["create", "--path", "Cli/history.md", "--content", "First words.\n", "--why", "agent", "--agent", "shell-agent"]);
  const versions = JSON.parse(ob(["history", "--path", "Cli/history.md", "--json"]).stdout || "{}").versions ?? [];
  check("history through the plugin shows who made a note", versions[0]?.status === "created" && versions[0].authors.includes("agent:shell-agent"), JSON.stringify(versions));
  ob(["append", "--path", "Cli/history.md", "--text", "More words.\n", "--why", "agent", "--agent", "shell-agent"]);
  check("a read from before a note existed says so", ob(["read", "--path", "Cli/history.md", "--at", "1w"]).stderr.includes("didn't exist yet"));
  check("a version's time reads back through the plugin", ob(["read", "--path", "Cli/history.md", "--at", versions[0]?.at ?? "1m"]).stdout.startsWith("First words."));

  const since = new Date().toISOString();
  const recent = () => JSON.parse(ob(["activities", "--since", since, "--limit", "100", "--json"]).stdout || "{}").changes ?? [];
  const recentLine = (path) => recent().find((c) => c.path === path);
  const lineBecomes = (path, ok) => eventually(async () => [recentLine(path)].find((c) => c && ok(c)));
  const newestVersion = (path) => JSON.parse(ob(["history", "--path", path, "--json"]).stdout || "{}").versions?.[0];
  ob(["create", "--path", "Cli/activity.md", "--content", "First line.\n", "--why", "agent", "--agent", "shell-agent"]);
  const made = await lineBecomes("Cli/activity.md", (c) => c.status === "created" && c.added === 1 && c.authors.includes("agent:shell-agent"));
  check("activities through the plugin shows a new note", !!made, JSON.stringify(recent()));
  ob(["append", "--path", "Cli/activity.md", "--text", "Second line.\n", "--why", "agent", "--agent", "shell-agent"]);
  const squashed = await lineBecomes("Cli/activity.md", (c) => c.status === "created" && c.added === 2 && c.removed === 0);
  check("activities through the plugin squashes a note's changes into one line", !!squashed && recent().filter((c) => c.path === "Cli/activity.md").length === 1, JSON.stringify(recent()));
  check("activities prints a line with its time zone, path, author, counts and preview", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2} {2}Cli\/activity\.md \(new\) {2}agent:shell-agent {2}\+2 -0 {2}\+ First line\. \/ Second line\.$/m.test(ob(["activities", "--since", since, "--limit", "100"]).stdout), ob(["activities", "--since", since, "--limit", "100"]).stdout);
  check("activities drops a note none of the asked-for authors touched", !JSON.parse(ob(["activities", "--since", since, "--limit", "100", "--author", "human:nobody", "--skip-unknown", "--json"]).stdout || "{}").changes?.some((c) => c.path === "Cli/activity.md"));
  check("activities refuses a bad author as a wrong call", ob(["activities", "--since", "2h", "--author", "nobody"]).status === 2);

  ob(["append", "--path", "Bulk/n7.md", "--text", "Added here.\n", "--why", "agent", "--agent", "shell-agent"]);
  const olderNote = await lineBecomes("Bulk/n7.md", (c) => c.status === "modified" && c.added === 1 && c.removed === 0);
  check("activities through the plugin shows an edit to an older note", !!olderNote, JSON.stringify(recent()));
  const renameCall = ob(["rename", "--from", "Bulk/n7.md", "--to", "Cli/activity-moved.md"]);
  check("ob-provenance renames a note", renameCall.status === 0, JSON.stringify(renameCall));
  const renamedLine = await lineBecomes("Cli/activity-moved.md", (c) => c.status === "renamed" && c.from === "Bulk/n7.md" && c.added === 1 && c.authors.includes("agent:shell-agent") && c.authors.includes("unknown"));
  check("activities through the plugin shows a rename under the new path, with the edit's counts", !!renamedLine, JSON.stringify(recent()));
  const renamedVersion = newestVersion("Bulk/n7.md");
  check("history through the plugin follows a rename from the old path", renamedVersion?.status === "renamed" && renamedVersion.path === "Cli/activity-moved.md" && renamedVersion.from === "Bulk/n7.md", JSON.stringify(renamedVersion));
  check("history through the plugin gives the same versions under the new path", JSON.stringify(newestVersion("Cli/activity-moved.md")) === JSON.stringify(renamedVersion), JSON.stringify(newestVersion("Cli/activity-moved.md")));
  const deleteCall = ob(["delete", "--path", "Cli/activity-moved.md"]);
  check("ob-provenance deletes a note", deleteCall.status === 0, JSON.stringify(deleteCall));
  const gone = await lineBecomes("Bulk/n7.md", (c) => c.status === "deleted" && c.added === 0 && c.removed === 1);
  check("activities through the plugin shows a deletion under the path the range began with", !!gone, JSON.stringify(recent()));
  check("activities through the plugin leaves no line under the renamed path after a deletion", !recentLine("Cli/activity-moved.md"), JSON.stringify(recent()));
  const deletedVersion = newestVersion("Cli/activity-moved.md");
  check("history through the plugin follows a deleted note by its last path", deletedVersion?.status === "deleted" && deletedVersion.path === "Cli/activity-moved.md", JSON.stringify(deletedVersion));
  check("history through the plugin follows a deleted note by a path it had before", JSON.stringify(newestVersion("Bulk/n7.md")) === JSON.stringify(deletedVersion), JSON.stringify(newestVersion("Bulk/n7.md")));

  // Obsidian holds every rename until it has indexed the vault, so this stays after the renames: it was still indexing this note 90 seconds on.
  const beforeBig = new Date().toISOString();
  const big = "A long line of a long note.\n".repeat(190_000);
  check("a 5 MB note goes through a request file", cliCall({ op: "create", path: "Cli/big.md", content: big, by }).ok === true && cliCall({ op: "read", path: "Cli/big.md" }).result?.content === big);
  const bigLine = (() => {
    const answer = ob(["activities", "--since", beforeBig, "--limit", "100", "--json"]);
    return { answer, line: JSON.parse(answer.stdout || "{}").changes?.find((c) => c.path === "Cli/big.md") };
  })();
  check("activities through the plugin answers beside a 5 MB note", bigLine.line?.status === "created" && bigLine.line.added === 190_000, JSON.stringify({ line: bigLine.line, status: bigLine.answer.status, stderr: bigLine.answer.stderr }));
  const bigHistory = ob(["history", "--path", "Cli/big.md", "--json"]);
  check("history through the plugin answers for a 5 MB note", JSON.parse(bigHistory.stdout || "{}").versions?.[0]?.added === 190_000, JSON.stringify({ status: bigHistory.status, stderr: bigHistory.stderr }));
  const stored = await cdp.eval(`const e = ${plugin}.engine;
    const before = (await indexedDB.databases()).map((d) => d.name);
    const index = before.find((n) => n.endsWith("/e2e/index"));
    const old = index.replace(/index$/, "journal/5");
    await new Promise((resolve, reject) => { const q = indexedDB.open(old); q.onsuccess = () => { q.result.close(); resolve(); }; q.onerror = () => reject(q.error); });
    const listed = await e.opts.stored.names();
    await e.dropOldWeeks();
    const after = (await indexedDB.databases()).map((d) => d.name);
    return { listed: listed.includes("e2e/journal/5"), old: after.includes(old), index: after.includes(index), week: after.some((n) => /\\/e2e\\/journal\\/\\d{4}$/.test(n)) }`);
  check("real IndexedDB lists a journal week by its document's name", stored.listed, JSON.stringify(stored));
  check("real IndexedDB drops an old journal week and nothing else", !stored.old && stored.index && stored.week, JSON.stringify(stored));

  const mcpClient = new Client({ name: "shell client", version: "0" });
  await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "apps/cli/dist/cli.js"), "--vault", "e2evault", "mcp"], env: instance.env, cwd: work }));
  const overMcp = await mcpClient.callTool({ name: "get_backlinks", arguments: { path: "Welcome.md" } });
  const mcpWrite = await mcpClient.callTool({ name: "append_to_file", arguments: { path: "Cli/shell.md", text: " Over MCP.", why: "agent" } });
  await mcpClient.close();
  check("ob-provenance mcp serves the full tools through Obsidian", !overMcp.isError && overMcp.content[0].text.includes("Projects/Roadmap.md"), JSON.stringify(overMcp.content));
  check("ob-provenance mcp names the agent after the MCP client", !mcpWrite.isError && ob(["read", "--path", "Cli/shell.md", "--provenance"]).stdout.includes("[agent agent:shell-client] Over MCP."), JSON.stringify(mcpWrite.content));

  // The delay holds the write open, so the restart below arrives while it's in flight.
  await cdp.eval(`const e = app.plugins.plugins["provenance-sync"].engine; const update = e.updateText;
    e.updateText = async function (...args) { await new Promise((r) => setTimeout(r, 1500)); return update.apply(this, args); }; return true`);
  const inFlight = new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repo, "apps/cli/dist/cli.js"), "--vault", "vault", "append", "--path", "Cli/shell.md", "--text", " During a restart.", "--why", "agent", "--agent", "shell-agent"], { env: instance.env, cwd: work, stdio: "ignore" });
    child.on("close", resolve);
  });
  await sleep(500);
  await cdp.eval(`await app.plugins.plugins["provenance-sync"].restartSync(); return true`);
  const inFlightCode = await inFlight;
  const afterRestart = await eventually(async () => {
    const text = ob(["read", "--path", "Cli/shell.md", "--provenance"]).stdout;
    return text.includes("During a restart.") ? text : undefined;
  });
  check("a restart waits for a write in flight and keeps its author", inFlightCode === 0 && afterRestart?.includes("[agent agent:shell-agent] During a restart."), JSON.stringify([inFlightCode, afterRestart]));

  const restarted = () => cdp.eval(`return await Promise.race([${plugin}.restartSync().then(() => true), new Promise((r) => setTimeout(() => r(false), 25000))])`);

  // Settled first, so the error reaches the new engine's start and not the old one's shutdown.
  await cdp.eval(`await ${plugin}.engine.settle(); const g = app.vault.getFiles; app.vault.getFiles = () => { throw new Error("simulated disk error"); };
    try { await ${plugin}.restartSync(); } finally { app.vault.getFiles = g; } return true`);
  const failedStatus = ob(["status"]).stdout;
  check("after a failed sync start, the plugin leaves agents to the server", failedStatus.includes("Obsidian: not reachable: This vault isn't serving agents"), failedStatus);
  const failedRename = ob(["rename", "--from", "Cli/shell.md", "--to", "Cli/moved.md"]);
  check("after a failed sync start, a rename is refused", failedRename.status === 1 && ob(["read", "--path", "Cli/shell.md"]).status === 0, JSON.stringify(failedRename));
  await restarted();
  check("the plugin serves agents again after a good start", await eventually(async () => ob(["status"]).stdout.includes("Obsidian: reachable")));

  // The stalled server never sends this note's text, as when a connection drops just after an index update.
  serverProcess.kill("SIGSTOP");
  await sleep(300);
  const ghost = await cdp.eval(`const e = ${plugin}.engine; const id = crypto.randomUUID(); e.vaultIndex.doc.transact(() => e.vaultIndex.set(id, { type: "markdown", path: "Ghost.md" }), "from-another-device"); return id`);
  const ghostRead = ob(["read", "--path", "Ghost.md"]);
  await cdp.eval(`const e = ${plugin}.engine; e.vaultIndex.doc.transact(() => e.vaultIndex.delete(${JSON.stringify(ghost)}), "from-another-device"); return true`);
  serverProcess.kill("SIGCONT");
  check("a note whose text never arrives gets an answer, not a hang", ghostRead.status === 1 && ghostRead.stderr.includes("hasn't reached this device"), JSON.stringify(ghostRead));
  check("a sync restart goes ahead after that call", await restarted());

  await cdp.eval(`${plugin}.agentCalls.add(new Promise(() => {})); return true`);
  check("a stuck agent call can't hold up a sync restart forever", await restarted());
  await cdp.eval(`${plugin}.agentCalls.clear(); return true`);
  await eventually(async () => ob(["status"]).stdout.includes("Obsidian: reachable"));

  // As Daily notes does when Obsidian opens before another device's daily note has synced: it creates the note and opens it.
  await cdp.eval(`await ${plugin}.stopSync(); return true`);
  for (const path of ["Blank daily.md", "Blank open.md"]) {
    await opsCall({ op: "create", path, content: "Written elsewhere.\n", by: { agent: "agent:andy", why: "agent" } });
    await cdp.eval(`await app.vault.create(${JSON.stringify(path)}, ""); return true`);
  }
  await cdp.eval(`await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath("Blank open.md")); return true`);
  await restarted();
  for (const path of ["Blank daily.md", "Blank open.md"]) {
    const done = await eventually(async () => (readFileSync(join(vault, path), "utf8") === "Written elsewhere.\n" ? readdirSync(vault) : undefined));
    check(`a blank note created before sync gives way to the synced note, with no conflict copy (${path})`, !!done && !done.some((f) => f.startsWith(path.slice(0, -3) + " (conflict")), JSON.stringify(done ?? readdirSync(vault)));
    await sleep(3000);
    const kinds = (await opsCall({ op: "read", path, provenance: true })).result?.sentences?.map((s) => s.kind);
    const log = await cdp.eval(`return ${plugin}.log.entries.filter((e) => e.path === ${JSON.stringify(path)}).map((e) => e.level + " " + e.message)`);
    check(`the synced note keeps its author (${path})`, isDeepStrictEqual(kinds, ["agent"]), JSON.stringify({ kinds, log }));
  }
  await cdp.eval(`app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file?.path === "Blank open.md").forEach((l) => l.detach()); return true`);

  const notesBefore = ob(["list"]).stdout;
  const unnamed = ob(["append", "--path", "Cli/shell.md", "--text", "lost", "--why", "agent", "--agent", "shell-agent"], { env: instance.env });
  check("a call that names no vault refuses and lists them, even with one vault", unnamed.status === 2 && /--vault <name> or OB_PROVENANCE_VAULT.*vault \(id e2evault/.test(unnamed.stderr), JSON.stringify(unnamed));
  check("the refused call changed nothing", ob(["list"]).stdout === notesBefore && !ob(["read", "--path", "Cli/shell.md"]).stdout.includes("lost"));
  const insideVault = ob(["list", "--prefix", "Cli/"], { cwd: join(vault, "Projects"), env: instance.env });
  check("the folder a call runs in doesn't choose its vault", insideVault.status === 2, JSON.stringify(insideVault));
  await sleep(100);
  writeFileSync(bin, "// ob-provenance 99.0.0\n");
  await setAgentCli(false);
  await eventually(async () => !existsSync(entry));
  check("turning Agent CLI off removes this vault's entry", !existsSync(entry));
  await setAgentCli(true);
  await eventually(async () => existsSync(entry));
  check("an older plugin leaves a newer CLI alone", readFileSync(bin, "utf8") === "// ob-provenance 99.0.0\n");
  rmSync(bin);
  await cdp.eval(`app.plugins.plugins["provenance-sync"].syncAgentCli(); return true`);
  check("the plugin reinstalls a missing CLI", !!(await eventually(async () => existsSync(bin))));

  await opsCall({ op: "append", path: "Welcome.md", text: "RemoteAgent line.", by: { agent: "agent:andy", why: "agent" } });
  const remote = await eventually(async () => {
    const counts = await cdp.eval(`return app.workspace.getLeavesOfType("markdown").map(l => l.view.editor.getValue().split("RemoteAgent").length - 1)`);
    return counts.every((c) => c === 1) ? counts : undefined;
  });
  check("a remote agent edit appears once in every pane", !!remote);
  const noDupes = (await cdp.eval(`return ${engineFile("Welcome.md")}.ytext.toJSON()`)).match(/TypedLeft|TypedRight|ExternalEdit|RemoteAgent/g);
  check("nothing was duplicated", noDupes?.length === 4, JSON.stringify(noDupes));

  await focusPane(cdp, 0);
  const recovered = await reattributeVia(cdp, "recover-provenance", "ExternalEdit line.", { why: "human-typed" });
  check("recovery attributes unknown text to the human", JSON.stringify(await authorsOf(cdp, "Welcome.md", "ExternalEdit line.")) === '["human:tester"]', recovered);
  const untouched = await reattributeVia(cdp, "recover-provenance", "RemoteAgent line.", { why: "human-typed" });
  check(
    "recovery never turns an agent's text into the human's",
    JSON.stringify(await authorsOf(cdp, "Welcome.md", "RemoteAgent line.")) === '["agent:andy"]' && untouched.includes("No unknown text"),
    untouched,
  );
  const marked = await reattributeVia(cdp, "mark-as-ai", "TypedRight", { agent: "gpt-e2e" });
  check("mark as AI attributes the human's text to the named agent", JSON.stringify(await authorsOf(cdp, "Welcome.md", "TypedRight")) === '["agent:gpt-e2e"]', marked);
  const authorsOnServer = async () => {
    const r = await opsCall({ op: "read", path: "Welcome.md", provenance: true });
    const of = (m) => r.result?.sentences?.find((x) => x.text.includes(m))?.authors ?? [];
    return { external: of("ExternalEdit"), typed: of("TypedRight") };
  };
  const synced = await eventually(async () => {
    const { external, typed } = await authorsOnServer();
    return external.join() === "human:tester" && typed.includes("agent:gpt-e2e") ? true : undefined;
  });
  check("reattribution syncs to the server", !!synced, JSON.stringify(await authorsOnServer()));
  check("reattribution leaves the file's text alone", (await cdp.eval(`return ${engineFile("Welcome.md")}.ytext.toJSON()`)).match(/TypedLeft|TypedRight|ExternalEdit|RemoteAgent/g)?.length === 4);

  await cdp.eval(`await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath("Projects/Roadmap.md")); await new Promise(r => setTimeout(r, 800)); return true`);
  const box = await cdp.eval(`const el = [...document.querySelectorAll(".workspace-leaf.mod-active .prov-agent")].find(e => e.textContent.includes("AgentBridge"));
    el.scrollIntoView({ block: "center" }); await new Promise(r => setTimeout(r, 300)); const r = el.getClientRects()[0]; return [r.left + Math.min(30, r.width / 2), r.top + r.height / 2]`);
  await cdp.shot("hover");
  await cdp.hover(box[0], box[1]);
  await cdp.hover(box[0] + 2, box[1]);
  const tooltip = await eventually(() => cdp.eval(`return document.querySelector(".prov-tooltip")?.innerText`), 3000);
  check("hover shows the agent and its note", !!tooltip?.includes("agent:e2e-client") && tooltip.includes("e2e note"), JSON.stringify(tooltip));

  // Leaving a note with an edit not saved yet: Obsidian blanks the editor while the pane still
  // names the note. Before the fix that blank was merged as the note's text, deleting what the
  // last save held. A save has to land first, and the agent's text has to arrive after it.
  writeFileSync(join(vault, "Left.md"), "");
  await eventually(() => cdp.eval(`return !!${engineFile("Left.md")}`));
  await openAndFocus(cdp, "Left.md");
  await cdp.type("Hand ");
  check("typed text is saved before the agent writes", !!(await eventually(async () => readFileSync(join(vault, "Left.md"), "utf8") === "Hand ")), JSON.stringify(readFileSync(join(vault, "Left.md"), "utf8")));
  const dictated = await mcpCall("append_to_file", { path: "Left.md", text: "dictated.", why: "human-via-agent" });
  check("an agent appends to a note open in a pane", !dictated.isError, JSON.stringify(dictated.content));
  await eventually(() => cdp.eval(`return ${engineFile("Left.md")}.ytext.toJSON() === "Hand dictated."`));
  await cdp.eval(`await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath("Projects/Roadmap.md")); return true`);
  await sleep(1000);
  appendFileSync(join(vault, "Left.md"), "\nOutsideWrite line.\n");
  await sleep(1500);
  const leftText = readFileSync(join(vault, "Left.md"), "utf8");
  check("leaving a note before its save loses nothing", leftText === "Hand dictated.\nOutsideWrite line.\n", JSON.stringify(leftText));
  check("the typed text stays the human's", JSON.stringify(await authorsOf(cdp, "Left.md", "Hand")) === '["human:tester"]', JSON.stringify(await authorsOf(cdp, "Left.md", "Hand")));
  check("another program's edit to a closed file stays unknown", JSON.stringify(await authorsOf(cdp, "Left.md", "OutsideWrite line.")) === '["unknown"]', JSON.stringify(await authorsOf(cdp, "Left.md", "OutsideWrite line.")));

  // Between files the pane names the new note while the editor still holds the old one, for as
  // long as the read takes. Any update then bound the new note to the old note's text, and the
  // real load only put the words back as unknown. The read is slowed to hold that window open.
  const placed = await mcpCall("create_file", { path: "Next.md", content: "AgentOwned line.\n", why: "agent" });
  check("an agent creates a note", !placed.isError, JSON.stringify(placed.content));
  await eventually(() => cdp.eval(`return ${engineFile("Next.md")}?.ytext.length > 0`));
  await cdp.eval(`const read = app.vault.read;
    app.vault.read = async function (f) { if (f.path === "Next.md") await new Promise((r) => setTimeout(r, 400)); return read.call(this, f); };
    const leaf = app.workspace.getLeaf(false);
    const opening = leaf.openFile(app.vault.getFileByPath("Next.md"));
    await new Promise((r) => setTimeout(r, 100));
    leaf.view.editor.cm.dispatch({});
    await opening; app.vault.read = read; return true`);
  await sleep(500);
  const owned = await authorsOf(cdp, "Next.md", "AgentOwned");
  check("opening a note keeps its authors while the read is pending", owned.length === 1 && owned[0].startsWith("agent:"), JSON.stringify(owned));

  // A rename is not a load: the pane's unsaved text is already in the CRDT, so rebinding merged it twice.
  writeFileSync(join(vault, "Move.md"), "Before.\n");
  await eventually(() => cdp.eval(`return !!${engineFile("Move.md")}`));
  await openAndFocus(cdp, "Move.md", 1);
  await cdp.type("Typed ");
  await cdp.eval(`await app.vault.rename(app.vault.getFileByPath("Move.md"), "Moved.md"); return true`);
  await sleep(100);
  await cdp.type("More ");
  await sleep(3000);
  const movedText = readFileSync(join(vault, "Moved.md"), "utf8");
  check("renaming a note with unsaved text keeps it single", movedText === "Before.\nTyped More ", JSON.stringify(movedText));

  // An error in the editor binding made CodeMirror drop it for good: the pane stopped syncing, the engine wrote
  // the file under its unsaved typing, and later merges typed recent words in a second time.
  writeFileSync(join(vault, "Fails.md"), "Before.\n");
  await eventually(() => cdp.eval(`return !!${engineFile("Fails.md")}`));
  await openAndFocus(cdp, "Fails.md", 1);
  await cdp.type("Saved ");
  await sleep(2500);
  await cdp.type("One ");
  await cdp.eval(`const t = ${engineFile("Fails.md")}.ytext; const insert = t.insert;
    t.insert = function () { t.insert = insert; throw new Error("simulated push failure"); }; return true`);
  await cdp.type("Two ");
  await sleep(500);
  await cdp.type("Three ");
  await sleep(3000);
  const failed = { disk: readFileSync(join(vault, "Fails.md"), "utf8"), crdt: await cdp.eval(`return ${engineFile("Fails.md")}.ytext.toJSON()`) };
  check("an error in an editor's sync keeps its typing single", failed.disk === "Before.\nSaved One Two Three " && failed.crdt === failed.disk, JSON.stringify(failed));
  check("an error in an editor's sync is in the event log", await cdp.eval(`return ${plugin}.log.entries.some((e) => e.message.includes("simulated push failure"))`));

  // Obsidian edits in places other than the pane's own editor. Each of these corrupted the note.
  mkdirSync(join(vault, "Editors/Templates"), { recursive: true });
  writeFileSync(join(vault, "Editors/Templates/Front.md"), "---\nkind: tpl\n---\nBody from template.\n");
  const cursorAtEnd = (line) => cdp.eval(`const e = app.workspace.activeLeaf.view.editor; e.setCursor({ line: ${line}, ch: e.getLine(${line}).length }); e.cm.focus(); return true`);
  const openInLivePreview = async (path, text, line) => {
    writeFileSync(join(vault, path), text);
    await eventually(() => cdp.eval(`return !!${engineFile(path)}`));
    await openInMode(cdp, "app.workspace.getLeaf(false)", path, "source");
    await cursorAtEnd(line);
  };
  const settledText = async (path) => {
    await sleep(3000);
    return { disk: readFileSync(join(vault, path), "utf8"), crdt: await cdp.eval(`return ${engineFile(path)}.ytext.toJSON()`), pane: await cdp.eval(`return app.workspace.activeLeaf.view.editor.getValue()`) };
  };
  const agreed = (s) => s.disk === s.crdt && s.crdt === s.pane;
  const times = (text, marker) => text.split(marker).length - 1;

  // A Live Preview table cell is an editor of its own, inside the note's.
  await openInLivePreview("Editors/Table.md", "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n", 4);
  await cdp.click(".markdown-source-view .cm-table-widget td", 0);
  await sleep(300);
  await cdp.type("Z");
  await sleep(200);
  await cdp.eval(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })); return true`);
  const table = await settledText("Editors/Table.md");
  check("typing in a Live Preview table cell edits that cell once", agreed(table) && /^\| *a *\| *b *\|\n\| *-+ *\| *-+ *\|\n\| *(Z1|1Z) *\| *2 *\|\n\nAfter\.\n$/.test(table.crdt), JSON.stringify(table));

  await openInLivePreview("Editors/Property.md", "---\nstatus: draft\n---\nBody.\n", 3);
  await cdp.type(" typed");
  await sleep(100);
  await cdp.eval(`app.workspace.activeLeaf.view.metadataEditor.insertProperties({ extra: "added" }); return true`);
  await sleep(300);
  await cursorAtEnd(4);
  await cdp.type(" after");
  const property = await settledText("Editors/Property.md");
  check("adding a property after typing keeps the typing single", agreed(property) && property.crdt === "---\nstatus: draft\nextra: added\n---\nBody. typed after\n", JSON.stringify(property));

  await cdp.eval(`app.internalPlugins.getPluginById("templates").instance.options.folder = "Editors/Templates"; return true`);
  await openInLivePreview("Editors/Template.md", "Note.\n\n", 0);
  await cdp.type(" typed");
  await cursorAtEnd(1);
  await cdp.eval(`await app.internalPlugins.getPluginById("templates").instance.insertTemplate(app.vault.getFileByPath("Editors/Templates/Front.md")); return true`);
  await sleep(500);
  await cdp.type("after");
  const template = await settledText("Editors/Template.md");
  check("inserting a template with frontmatter after typing adds each text once",
    agreed(template) && template.crdt.startsWith("---\nkind: tpl\n---\n") && ["kind: tpl", "Note. typed", " typed", "Body from template.", "after"].every((m) => times(template.crdt, m) === 1),
    JSON.stringify(template));

  // The pane reloads the engine's write of a remote edit, and the user deletes that edit before the
  // pane binds. Its text is then the one that write replaced, which binding took for a pane that
  // never reloaded (L5), so the deletion was undone. A queued task holds the bind back.
  writeFileSync(join(vault, "Undo.md"), "Base.\n");
  await eventually(() => cdp.eval(`return !!${engineFile("Undo.md")}?.loaded`));
  await cdp.eval(`await ${plugin}.engine.settle(); void ${plugin}.engine.enqueue(() => new Promise((r) => setTimeout(r, 2500))); return true`);
  await openAndFocus(cdp, "Undo.md");
  await cdp.eval(`const f = ${engineFile("Undo.md")}; f.ytext.insert(5, " Remote."); await f.flush(); return true`);
  const reloaded = await eventually(() => cdp.eval(`return app.workspace.activeEditor.editor.getValue() === "Base. Remote.\\n"`), 2000);
  await cdp.eval(`const e = app.workspace.activeEditor.editor; e.setSelection({ line: 0, ch: 5 }, { line: 0, ch: 13 }); return true`);
  await cdp.press("Backspace", 8);
  const undone = await settledText("Undo.md");
  check("deleting a remote edit before the pane binds keeps it deleted", !!reloaded && agreed(undone) && undone.crdt === "Base.\n", JSON.stringify({ reloaded, ...undone }));

  await cdp.eval(`await app.plugins.plugins["provenance-sync"].engine.settle(); return true`);
  await sleep(1500);
  ob(["create", "--path", "Cli/late.md", "--content", "Base.\n", "--why", "agent", "--agent", "shell-agent"]);
  const late = join(work, "late-request.json");
  writeFileSync(late, JSON.stringify({ op: "append", path: "Cli/late.md", text: "Late.\n", by: { agent: "agent:shell-agent", why: "agent" } }));
  writeFileSync(`${late}.taken`, "");
  instance.cli("provenance-sync", `request=${late}`);
  const lateText = ob(["read", "--path", "Cli/late.md"]).stdout;
  check("a request ob-provenance gave up on doesn't run when it reaches the plugin", lateText.includes("Base.") && !lateText.includes("Late."), lateText);
  ob(["create", "--path", "Cli/crash.md", "--content", "Base.\n", "--why", "agent", "--agent", "shell-agent"]);
  await sleep(1000);
  // The delay holds the reply back after the write, so the crash below lands between the two.
  await cdp.eval(`const e = ${plugin}.engine; const update = e.updateText;
    e.updateText = async function (...args) { const out = await update.apply(this, args); await new Promise((r) => setTimeout(r, 6000)); return out; }; return true`);
  const crashed = new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repo, "apps/cli/dist/cli.js"), "--vault", "vault", "append", "--path", "Cli/crash.md", "--text", "Once.\n", "--why", "agent", "--agent", "shell-agent"], { env: instance.env, cwd: work, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stderr }));
  });
  await sleep(2500);
  cdp.close();
  await instance.kill();
  const crash = await crashed;
  check("a write cut off by a crash says so", crash.status === 1 && crash.stderr.includes("may have landed"), JSON.stringify(crash));
  check("a write cut off by a crash isn't sent to the server again", (await opsCall({ op: "read", path: "Cli/crash.md" })).result?.content === "Base.\nOnce.\n");

  const roadmap = join(vault, "Projects/Roadmap.md");
  writeFileSync(join(vault, "Projects/Renamed.md"), readFileSync(roadmap, "utf8") + "OfflineEdit line.\n");
  unlinkSync(roadmap);
  unlinkSync(join(vault, "Welcome.md"));
  const fallback = await mcpCall("append_to_file", { path: "Projects/Roadmap.md", text: "- WhileClosed line.\n", why: "agent" });
  check("with Obsidian closed, local MCP falls back to the server", !fallback.isError, JSON.stringify(fallback.content));
  const closedWrite = ob(["append", "--path", "Projects/Roadmap.md", "--text", "- ClosedShell line.\n", "--why", "agent", "--agent", "shell-agent"]);
  check("with Obsidian closed, ob-provenance writes through the server", closedWrite.status === 0, JSON.stringify(closedWrite));
  const closedSearch = ob(["search", "--query", "x"]);
  check("with Obsidian closed, ob-provenance says why it can't search", closedSearch.status === 1 && closedSearch.stderr.includes("unable to find Obsidian"), JSON.stringify(closedSearch));
  check("ob-provenance status shows the server route", /Obsidian: not reachable[\s\S]*Sync server: \S+ reachable/.test(ob(["status"]).stdout), ob(["status"]).stdout);

  cdp = await openObsidian().catch(async () => {
    // Welcome.md is gone, so the readiness probe above can't use it.
    return eventually(() => instance.page(), 30000);
  });
  for (const [path, saved] of localApiSaved) {
    check(`local API provenance survives saving and restarting (${path})`, !!(await eventually(async () => isDeepStrictEqual(await snapshotOf(cdp, path), saved))), JSON.stringify(await snapshotOf(cdp, path)));
  }
  const files = await eventually(async () => {
    const r = await opsCall({ op: "list" });
    const notes = r.result.files.filter(
      (f) => !localApiSaved.has(f),
    ).filter(
      (f) => !f.startsWith("Bulk/") && !f.startsWith("McpMoved/") && !f.startsWith("Cli/") && !f.startsWith("Editors/") && !f.startsWith("LocalApi-") && !/^\d{4}-\d{2}-\d{2}\.md$/.test(f) && !["Lost.md", "pixel.png", "Left.md", "Next.md", "Moved.md", "Fails.md", "Linker.md", "DailyTemplate.md", "Tasks.md", "Blank daily.md", "Blank open.md", "Undo.md"].includes(f),
    );
    return notes.join(",") === "Projects/Renamed.md" ? notes : undefined;
  }, 15000);
  check("an offline delete stays deleted and an offline rename keeps the file", !!files, JSON.stringify((await opsCall({ op: "list" })).result));
  const merged = await eventually(async () => {
    const r = await opsCall({ op: "read", path: "Projects/Renamed.md" });
    const c = r.result?.content ?? "";
    return c.includes("OfflineEdit") && c.includes("WhileClosed") ? c : undefined;
  }, 15000);
  check("edits made on both sides while closed are merged", !!merged);
  check("the merged note is written back to disk", existsSync(join(vault, "Projects/Renamed.md")) && readFileSync(join(vault, "Projects/Renamed.md"), "utf8").includes("WhileClosed"));

  // Closing the last window ends the app off macOS, so a cold call can't be tested there.
  if (process.platform === "darwin") {
    await cdp.eval(`window.close(); return true`).catch(() => undefined);
    await sleep(1500);
    const cold = cliCall({ op: "list", prefix: "Projects/" });
    check("a call to a closed vault opens it and waits for sync to start", cold.result?.files.includes("Projects/Renamed.md"), JSON.stringify(cold));
  }
  cdp?.close();
} catch (e) {
  check("run completed", false, e instanceof Error ? e.stack : String(e));
} finally {
  for (const c of children) c.kill("SIGKILL");
  await instance.kill();
  if (process.env.KEEP) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
