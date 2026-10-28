// End-to-end test against a real Obsidian. Copies test-vault to a temp folder, starts a sync
// server, launches Obsidian with an isolated profile (it never sees your own vaults), drives it
// over the Chrome DevTools protocol and exits non-zero if any check fails.
//
//   pnpm e2e                      (from the repo root; builds everything first)
//   OBSIDIAN_BIN=/path/to/Obsidian KEEP=1 node apps/obsidian/e2e/run.mjs
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const OBSIDIAN = process.env.OBSIDIAN_BIN ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const DEVICE_TOKEN = "e2e-device-token-0123456789";
const AGENT_TOKEN = "e2e-agent-token-0123456789";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const work = mkdtempSync(join(tmpdir(), "provenance-e2e-"));
const vault = join(work, "vault");
const profile = join(work, "profile");
const children = [];
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
}

async function eventually(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value || Date.now() > end) return value;
    await sleep(200);
  }
}

// --- fixtures ---------------------------------------------------------------

cpSync(join(repo, "test-vault"), vault, { recursive: true });
const pluginDir = join(vault, ".obsidian/plugins/provenance-sync");
mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(repo, "apps/obsidian", f), join(pluginDir, f));

const serverPort = await freePort();
const cdpPort = await freePort();
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
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, "obsidian.json"), JSON.stringify({ vaults: { e2evault: { path: vault, ts: Date.now(), open: true } } }));

// --- processes --------------------------------------------------------------

function startServer() {
  const child = spawn(process.execPath, [join(repo, "apps/server/dist/server.js"), join(work, "server.json")], { stdio: "ignore" });
  children.push(child);
}

let obsidian = null;
function startObsidian() {
  obsidian = spawn(OBSIDIAN, [`--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`], { stdio: "ignore" });
  children.push(obsidian);
}
/** Kills by profile path: on macOS the launched process isn't always the one that keeps running. */
async function killObsidian() {
  obsidian?.kill("SIGKILL");
  spawnSync("pkill", ["-9", "-f", `user-data-dir=${profile}`]);
  await sleep(1500);
}

/** Trusting a vault opens the plugin settings in a window of its own. */
async function closeSettingsWindows() {
  await sleep(1000);
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  for (const t of targets) if (t.type === "page" && t.title.startsWith("Settings")) await fetch(`http://127.0.0.1:${cdpPort}/json/close/${t.id}`);
}

// --- CDP --------------------------------------------------------------------

async function page() {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = targets.find((t) => t.type === "page" && t.title.includes("vault") && !t.title.startsWith("Settings"));
  if (!target) throw new Error("no vault window yet");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const call = (method, params) =>
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
  return {
    async eval(body) {
      const r = await call("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluation failed");
      return r.result.value;
    },
    async type(text) {
      for (const ch of text) await call("Input.insertText", { text: ch });
    },
    hover: (x, y) => call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
    close: () => ws.close(),
  };
}

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

async function opsCall(body) {
  const res = await fetch(api, { method: "POST", headers: { authorization: `Bearer ${AGENT_TOKEN}` }, body: JSON.stringify(body) });
  return res.json();
}

async function mcpCall(name, args) {
  const client = new Client({ name: "e2e", version: "0" });
  const cli = join(repo, "packages/mcp/dist/cli.js");
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--vault-path", vault, "--agent", "e2e-agent", "--server", `http://127.0.0.1:${serverPort}`, "--vault", "e2e", "--token", AGENT_TOKEN],
    }),
  );
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

async function openObsidian() {
  startObsidian();
  const cdp = await eventually(() => page(), 30000);
  if (!cdp) throw new Error(`Obsidian did not open a window (OBSIDIAN_BIN=${OBSIDIAN})`);
  if (!(await eventually(() => cdp.eval(`return !!window.app?.plugins && app.workspace.layoutReady`), 30000))) throw new Error("Obsidian never finished loading");
  // First open of a vault with plugins asks whether to trust it; answer like a user would.
  const trusted = await eventually(
    () => cdp.eval(`const b = [...document.querySelectorAll(".modal button")].find(b => b.innerText.includes("Trust author")); b?.click(); return !!b`),
    8000,
  );
  if (trusted) await closeSettingsWindows();
  else await cdp.eval(`await app.plugins.setEnable(true); return true`);
  const synced = await eventually(() =>
    cdp.eval(`return document.querySelector(".status-bar")?.innerText.includes("Provenance: synced") && !!${engineFile("Welcome.md")}`),
  );
  if (!synced) throw new Error("plugin never reported synced");
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

  const edit = await mcpCall("append_to_file", { path: "Projects/Roadmap.md", text: "- AgentBridge line.\n", why: "agent", note: "e2e note" });
  check("local MCP edits through the plugin bridge", !edit.isError, JSON.stringify(edit.content));
  const links = await mcpCall("get_backlinks", { path: "Welcome.md" });
  check("full mode answers backlinks", !links.isError && links.content[0].text.includes("Projects/Roadmap.md"), JSON.stringify(links.content));

  await opsCall({ op: "append", path: "Welcome.md", text: "RemoteAgent line.", by: { agent: "agent:andy", why: "agent" } });
  const remote = await eventually(async () => {
    const counts = await cdp.eval(`return app.workspace.getLeavesOfType("markdown").map(l => l.view.editor.getValue().split("RemoteAgent").length - 1)`);
    return counts.every((c) => c === 1) ? counts : undefined;
  });
  check("a remote agent edit appears once in every pane", !!remote);
  const noDupes = (await cdp.eval(`return ${engineFile("Welcome.md")}.ytext.toJSON()`)).match(/TypedLeft|TypedRight|ExternalEdit|RemoteAgent/g);
  check("nothing was duplicated", noDupes?.length === 4, JSON.stringify(noDupes));

  await cdp.eval(`await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath("Projects/Roadmap.md")); await new Promise(r => setTimeout(r, 800)); return true`);
  const box = await cdp.eval(`const el = [...document.querySelectorAll(".workspace-leaf.mod-active .prov-agent")].find(e => e.textContent.includes("AgentBridge"));
    const r = el.getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]`);
  await cdp.hover(box[0], box[1]);
  await cdp.hover(box[0] + 2, box[1]);
  const tooltip = await eventually(() => cdp.eval(`return document.querySelector(".prov-tooltip")?.innerText`), 3000);
  check("hover shows the agent and its note", !!tooltip?.includes("agent:e2e-agent") && tooltip.includes("e2e note"), JSON.stringify(tooltip));

  await cdp.eval(`await app.plugins.plugins["provenance-sync"].engine.settle(); return true`);
  await sleep(1500);
  cdp.close();
  await killObsidian();

  const roadmap = join(vault, "Projects/Roadmap.md");
  writeFileSync(join(vault, "Projects/Renamed.md"), readFileSync(roadmap, "utf8") + "OfflineEdit line.\n");
  unlinkSync(roadmap);
  unlinkSync(join(vault, "Welcome.md"));
  await opsCall({ op: "append", path: "Projects/Roadmap.md", text: "- WhileClosed line.\n", by: { agent: "agent:andy", why: "agent" } });

  cdp = await openObsidian().catch(async () => {
    // Welcome.md is gone, so the readiness probe above can't use it.
    return eventually(() => page(), 30000);
  });
  const files = await eventually(async () => {
    const r = await opsCall({ op: "list" });
    return r.result.files.join(",") === "Projects/Renamed.md" ? r.result.files : undefined;
  }, 15000);
  check("an offline delete stays deleted and an offline rename keeps the file", !!files, JSON.stringify((await opsCall({ op: "list" })).result));
  const merged = await eventually(async () => {
    const r = await opsCall({ op: "read", path: "Projects/Renamed.md" });
    const c = r.result?.content ?? "";
    return c.includes("OfflineEdit") && c.includes("WhileClosed") ? c : undefined;
  }, 15000);
  check("edits made on both sides while closed are merged", !!merged);
  check("the merged note is written back to disk", existsSync(join(vault, "Projects/Renamed.md")) && readFileSync(join(vault, "Projects/Renamed.md"), "utf8").includes("WhileClosed"));
  cdp?.close();
} catch (e) {
  check("run completed", false, e instanceof Error ? e.stack : String(e));
} finally {
  for (const c of children) c.kill("SIGKILL");
  await killObsidian();
  if (process.env.KEEP) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
