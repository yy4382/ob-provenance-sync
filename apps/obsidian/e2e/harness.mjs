// Starts a real Obsidian with an isolated profile, so it never sees your own vaults, and drives it
// over the Chrome DevTools protocol. Shared by the end-to-end test and the quirk probes.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

const OBSIDIAN = process.env.OBSIDIAN_BIN ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
// Extra command-line flags, split on spaces. CI needs some that a desktop doesn't.
const EXTRA_ARGS = process.env.OBSIDIAN_ARGS?.split(" ").filter(Boolean) ?? [];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether version `a` comes before version `b`. */
export function older(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

export const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

export async function eventually(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value || Date.now() > end) return value;
    await sleep(200);
  }
}

/** One Obsidian with its own profile, opening `vault`. Restartable: `kill`, then `open` again. */
export async function obsidian({ vault, profile }) {
  const cdpPort = await freePort();
  let child = null;
  mkdirSync(profile, { recursive: true });
  // Obsidian rebinds $HOME/.obsidian-cli.sock on start, so with the real HOME it would take the path
  // from your own Obsidian and leave it dead. Under /tmp, as macOS limits socket paths to 104 bytes.
  const home = mkdtempSync("/tmp/provenance-home-");
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
  // Obsidian's command line client, under its usual name. Builds without one answer through the app itself.
  const client = join(dirname(OBSIDIAN), "obsidian-cli");
  const clientCommand = existsSync(client) ? [client] : [OBSIDIAN, `--user-data-dir=${profile}`, ...EXTRA_ARGS];
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin/obsidian"), `#!/bin/sh\nexec ${clientCommand.map((a) => JSON.stringify(a)).join(" ")} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: home, PATH: `${join(home, "bin")}:${process.env.PATH}` };
  // Without this, macOS looks for a login keychain in the new HOME and Obsidian hangs.
  const keychainArgs = process.platform === "darwin" ? ["--use-mock-keychain"] : [];
  // A run must stay on the version it was started with, or a restart could test a newer one.
  writeFileSync(join(profile, "obsidian.json"), JSON.stringify({ updateDisabled: true, cli: true, vaults: { e2evault: { path: vault, ts: Date.now(), open: true } } }));

  /** Trusting a vault opens the plugin settings in a window of its own. */
  async function closeSettingsWindows() {
    await sleep(1000);
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    for (const t of targets) if (t.type === "page" && t.title.startsWith("Settings")) await fetch(`http://127.0.0.1:${cdpPort}/json/close/${t.id}`);
  }

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
      /** Saves a screenshot to $SHOTS/<name>.png when SHOTS is set, for looking at the UI by eye. */
      async shot(name) {
        if (!process.env.SHOTS) return;
        const r = await call("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(process.env.SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
      },
      close: () => ws.close(),
    };
  }

  /** Launches Obsidian and answers its first-run questions; resolves once community plugins are on. */
  async function open() {
    child = spawn(OBSIDIAN, [`--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, ...keychainArgs, ...EXTRA_ARGS], { stdio: "ignore", env });
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
    return cdp;
  }

  /** Kills by profile path: on macOS the launched process isn't always the one that keeps running. */
  async function kill() {
    child?.kill("SIGKILL");
    spawnSync("pkill", ["-9", "-f", `user-data-dir=${profile}`]);
    await sleep(1500);
  }

  /** Runs `obsidian` against this instance, never yours. */
  const cli = (...args) => spawnSync("obsidian", ["vault=e2evault", ...args], { env, encoding: "utf8", timeout: 30000, maxBuffer: 1 << 26 });

  return { open, page, kill, env, cli };
}
