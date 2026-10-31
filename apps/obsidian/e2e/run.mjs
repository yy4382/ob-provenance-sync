// End-to-end test against a real Obsidian. Copies test-vault to a temp folder, starts a sync
// server, launches Obsidian with an isolated profile (it never sees your own vaults), drives it
// over the Chrome DevTools protocol and exits non-zero if any check fails.
//
//   pnpm e2e                      (from the repo root; builds everything first)
//   OBSIDIAN_BIN=/path/to/Obsidian KEEP=1 node apps/obsidian/e2e/run.mjs
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
writeFileSync(corePlugins, JSON.stringify({ ...(existsSync(corePlugins) ? JSON.parse(readFileSync(corePlugins, "utf8")) : {}), sync: false }));
const pluginDir = join(vault, ".obsidian/plugins/provenance-sync");
mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(repo, "apps/obsidian", f), join(pluginDir, f));

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
  JSON.stringify({ serverUrl: `http://127.0.0.1:${serverPort}`, token: DEVICE_TOKEN, vaultId: "e2e", humanName: "tester", deviceName: "e2e-mac" }),
);

// --- processes --------------------------------------------------------------

function startServer() {
  const child = spawn(process.execPath, [join(repo, "apps/server/dist/server.js"), join(work, "server.json")], { stdio: "ignore" });
  children.push(child);
}

const instance = await obsidian({ vault, profile });

const engineFile = (path) => `app.plugins.plugins["provenance-sync"].engine.fileAt(${JSON.stringify(path)})`;
/** Distinct authors of the characters of `marker`, which may span several Yjs runs. */
const authorsOf = (cdp, path, marker) =>
  cdp.eval(`const t = ${engineFile(path)}.ytext; const from = t.toJSON().indexOf(${JSON.stringify(marker)}); if (from < 0) return [];
    const to = from + ${marker.length}; const out = new Set(); let pos = 0;
    for (const d of t.toDelta()) { const end = pos + d.insert.length; if (end > from && pos < to) out.add(d.attributes?.pa ?? "none"); pos = end; }
    return [...out]`);

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

async function opsCall(body) {
  const res = await fetch(api, { method: "POST", headers: { authorization: `Bearer ${AGENT_TOKEN}` }, body: JSON.stringify(body) });
  return res.json();
}

/** The command the plugin's settings hand out for local agents, with its embedded MCP server. */
let mcpCommand = null;

async function mcpCall(name, args) {
  const client = new Client({ name: "e2e client", version: "0" });
  await client.connect(new StdioClientTransport({ ...mcpCommand, env: { ...process.env, ...mcpCommand.env } }));
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
  spawnSync(process.execPath, [join(repo, "apps/cli/dist/cli.js"), ...args], { env: instance.env, cwd: work, encoding: "utf8", timeout: 30000, maxBuffer: 1 << 26, ...opts });

function registerVault() {
  const dir = join(instance.env.HOME, ".config/ob-provenance/vaults");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "e2evault.json"), JSON.stringify({ name: "vault", path: vault, server: { url: `http://127.0.0.1:${serverPort}`, vault: "e2e", token: DEVICE_TOKEN } }));
}

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
  startServer();
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

  mcpCommand = await eventually(() => cdp.eval(`return app.plugins.plugins["provenance-sync"].mcpCommand()`));
  check("settings offer a local MCP command", mcpCommand?.args.includes(vault) && mcpCommand.args[0].endsWith("provenance-mcp.mjs"), JSON.stringify(mcpCommand));
  const edit = await mcpCall("append_to_file", { path: "Projects/Roadmap.md", text: "- AgentBridge line.\n", why: "agent", note: "e2e note" });
  check("local MCP edits through the plugin bridge", !edit.isError, JSON.stringify(edit.content));
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
  check("the daily template is unknown and the agent's text is the agent's", /^\[unknown\] Template line\.\n\[agent agent:.*\] AgentDaily line\./.test(dailyAuthors.content[0].text), dailyAuthors.content[0].text);
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
  const big = "A long line of a long note.\n".repeat(190_000);
  check("a 5 MB note goes through a request file", cliCall({ op: "create", path: "Cli/big.md", content: big, by }).ok === true && cliCall({ op: "read", path: "Cli/big.md" }).result?.content === big);

  registerVault();
  check("ob-provenance lists the registered vault", ob(["vaults"]).stdout.startsWith("vault\t"));
  check("ob-provenance reaches Obsidian", ob(["status"]).stdout.includes("Obsidian: reachable"), JSON.stringify(ob(["status"])));
  const written = ob(["create", "path=Cli/shell.md", "content=From the shell.", "why=agent", "agent=shell-agent"]);
  check("ob-provenance writes as the agent it names", written.status === 0 && ob(["read", "path=Cli/shell.md", "provenance"]).stdout === "[agent agent:shell-agent] From the shell.\n", JSON.stringify(written));
  const anonymous = ob(["append", "path=Cli/shell.md", "text=x", "why=agent"]);
  check("ob-provenance refuses a write with no identity", anonymous.status === 1 && anonymous.stderr.includes("agent=<name>"), JSON.stringify(anonymous));
  const piped = "two lines\nwith \"quotes\" and a trailing newline\n";
  ob(["create", "path=Cli/piped.md", "why=agent", "agent=shell-agent", "--stdin=content"], { input: piped });
  check("ob-provenance takes a field from stdin", ob(["read", "path=Cli/piped.md"]).stdout === piped);
  const unknownVault = ob(["vault=Nope", "list"]);
  check("ob-provenance names the vaults it knows", unknownVault.status === 2 && unknownVault.stderr.includes("vault (id e2evault"), JSON.stringify(unknownVault));
  check("ob-provenance prints an op error and exits 1", ob(["read", "path=Cli/missing.md"]).status === 1);
  check("ob-provenance searches", ob(["search", "query=AgentBridge"]).stdout.includes("Projects/Roadmap.md"));
  const mcpClient = new Client({ name: "shell client", version: "0" });
  await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "apps/cli/dist/cli.js"), "vault=e2evault", "mcp"], env: instance.env, cwd: work }));
  const overMcp = await mcpClient.callTool({ name: "get_backlinks", arguments: { path: "Welcome.md" } });
  const mcpWrite = await mcpClient.callTool({ name: "append_to_file", arguments: { path: "Cli/shell.md", text: " Over MCP.", why: "agent" } });
  await mcpClient.close();
  check("ob-provenance mcp serves the full tools through Obsidian", !overMcp.isError && overMcp.content[0].text.includes("Projects/Roadmap.md"), JSON.stringify(overMcp.content));
  check("ob-provenance mcp names the agent after the MCP client", !mcpWrite.isError && ob(["read", "path=Cli/shell.md", "provenance"]).stdout.includes("[agent agent:shell-client] Over MCP."), JSON.stringify(mcpWrite.content));

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

  await cdp.eval(`await app.plugins.plugins["provenance-sync"].engine.settle(); return true`);
  await sleep(1500);
  cdp.close();
  await instance.kill();

  const roadmap = join(vault, "Projects/Roadmap.md");
  writeFileSync(join(vault, "Projects/Renamed.md"), readFileSync(roadmap, "utf8") + "OfflineEdit line.\n");
  unlinkSync(roadmap);
  unlinkSync(join(vault, "Welcome.md"));
  const fallback = await mcpCall("append_to_file", { path: "Projects/Roadmap.md", text: "- WhileClosed line.\n", why: "agent" });
  check("with Obsidian closed, local MCP falls back to the server", !fallback.isError, JSON.stringify(fallback.content));
  const closedWrite = ob(["append", "path=Projects/Roadmap.md", "text=- ClosedShell line.\n", "why=agent", "agent=shell-agent"]);
  check("with Obsidian closed, ob-provenance writes through the server", closedWrite.status === 0, JSON.stringify(closedWrite));
  const closedSearch = ob(["search", "query=x"]);
  check("with Obsidian closed, ob-provenance says why it can't search", closedSearch.status === 1 && closedSearch.stderr.includes("unable to find Obsidian"), JSON.stringify(closedSearch));
  check("ob-provenance status shows the server route", /Obsidian: not reachable[\s\S]*Sync server: \S+ reachable/.test(ob(["status"]).stdout), ob(["status"]).stdout);

  cdp = await openObsidian().catch(async () => {
    // Welcome.md is gone, so the readiness probe above can't use it.
    return eventually(() => instance.page(), 30000);
  });
  const files = await eventually(async () => {
    const r = await opsCall({ op: "list" });
    const notes = r.result.files.filter(
      (f) => !f.startsWith("Bulk/") && !f.startsWith("McpMoved/") && !f.startsWith("Cli/") && !/^\d{4}-\d{2}-\d{2}\.md$/.test(f) && !["Lost.md", "pixel.png", "Left.md", "Next.md", "Moved.md", "Linker.md", "DailyTemplate.md"].includes(f),
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
