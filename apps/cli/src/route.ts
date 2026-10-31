import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage, FULL_ONLY_OPS, parseOpResponse, type OpRequest, type OpResponse } from "@provenance/core";
import type { OpsTransport } from "@provenance/tools";
import type { RegisteredVault, Selection } from "./vault";

const PLUGIN_ID = "provenance-sync";
const TIMEOUT_MS = 15_000;

const unavailable = (message: string): OpResponse => ({ ok: false, code: "unavailable", message });
const noAnswer = (timeoutMs: number) => `No answer within ${timeoutMs / 1000} seconds. A write may still land, so read the note before retrying.`;

/** Thrown when the far end can't be reached at all, as opposed to answering with an error. */
class Unreachable extends Error {}

function httpOps(url: string, token: string, timeoutMs: number): OpsTransport {
  return async (req) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // The far end may still finish this request.
      if (e instanceof Error && e.name === "TimeoutError") return unavailable(noAnswer(timeoutMs));
      throw new Unreachable(`${url}: ${errorMessage(e)}`);
    }
    if (res.status === 401) return unavailable(`${url} rejected the token`);
    const text = await res.text().catch(() => "");
    return parseOpResponse(text) ?? unavailable(`${url} answered ${res.status}: ${text.slice(0, 200) || "no details"}`);
  };
}

const remoteOps = (server: NonNullable<RegisteredVault["server"]>, timeoutMs: number) =>
  httpOps(`${server.url}/api/vaults/${encodeURIComponent(server.vault)}/ops`, server.token, timeoutMs);

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
  error: NodeJS.ErrnoException | null;
  timedOut: boolean;
}

function run(command: string, args: string[], timeoutMs: number): Promise<Finished> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // `obsidian` hangs if the vault's window closes during a call, so it needs a limit of ours.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // If `obsidian` is a wrapper script, the kill misses the process holding these pipes open.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({ code: null, stdout, stderr, error: null, timedOut });
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error: null, timedOut });
    });
  });
}

/** What became of a call to Obsidian. Only `missed` shows the plugin never ran it, so only `missed` may move on to the server. */
export type Attempt = { kind: "answered"; response: OpResponse } | { kind: "missed"; why: string } | { kind: "cut-off"; why: string };

/** `obsidian` exits 0 on most failures, so only a parsed response counts as an answer. */
export async function askObsidian(obsidian: string, vaultId: string, req: OpRequest, timeoutMs: number): Promise<Attempt> {
  const dir = await mkdtemp(join(tmpdir(), "ob-provenance-"));
  const file = join(dir, "request.json");
  await writeFile(file, JSON.stringify(req), { mode: 0o600 });
  try {
    const r = await run(obsidian, [`vault=${vaultId}`, PLUGIN_ID, `request=${file}`], timeoutMs);
    if (r.timedOut) return { kind: "cut-off", why: noAnswer(timeoutMs) };
    if (r.error?.code === "ENOENT") return { kind: "missed", why: "the obsidian command isn't on PATH. The human turns it on in Obsidian's settings, under General, Command line interface." };
    if (r.error) return { kind: "missed", why: r.error.message };
    const response = parseOpResponse(r.stdout);
    if (response) return { kind: "answered", response };
    // quirk: cli-cut-off-prints-nothing
    if (r.code === null || (r.code === 0 && !r.stdout.trim())) return { kind: "cut-off", why: "Obsidian stopped during the call. A write may have landed, so read the note before retrying." };
    return { kind: "missed", why: (r.code === 0 ? r.stdout : r.stderr).trim() || "it printed nothing" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The plugin when Obsidian answers, otherwise the sync server's limited API.
 * Looked up on every call because Obsidian may start or quit during an agent
 * session. A call that was cut off never moves on to the server: the first
 * request may have landed, and the second would write the same text again.
 */
export function agentOps(opts: { select: () => Promise<Selection>; obsidian?: string; timeoutMs?: number }): OpsTransport {
  const { obsidian = "obsidian", timeoutMs = TIMEOUT_MS } = opts;
  return async (req) => {
    const selection = await opts.select();
    if (!selection.ok) return { ok: false, code: "invalid", message: selection.message };
    const { vault } = selection;
    const attempt = await askObsidian(obsidian, vault.id, req, timeoutMs);
    if (attempt.kind === "answered") return attempt.response;
    if (attempt.kind === "cut-off") return unavailable(attempt.why);
    const answer = attempt.why;
    if (FULL_ONLY_OPS.has(req.op)) return unavailable(`This tool needs Obsidian running, and it didn't answer: ${answer}`);
    if (!vault.server) return unavailable(`Obsidian didn't answer and this vault has no sync server: ${answer}`);
    try {
      return await remoteOps(vault.server, timeoutMs)(req);
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e;
      return unavailable(`The vault is not available right now. Obsidian didn't answer (${answer}), and the sync server is unreachable.`);
    }
  };
}

/** What `status` shows: which way a call would go right now. */
export async function describeRoute(vault: RegisteredVault, obsidian = "obsidian", timeoutMs = TIMEOUT_MS): Promise<string[]> {
  const probe: OpRequest = { op: "list", prefix: "\0" };
  const local = await askObsidian(obsidian, vault.id, probe, timeoutMs);
  const lines = [`Vault: ${vault.name} (${vault.path})`, `Obsidian: ${local.kind === "answered" ? "reachable" : `not reachable: ${local.why}`}`];
  if (!vault.server) return [...lines, "Sync server: none"];
  let remote: string;
  try {
    const res = await remoteOps(vault.server, timeoutMs)(probe);
    remote = res.ok ? "reachable" : `not usable: ${res.message}`;
  } catch (e) {
    remote = `not reachable: ${errorMessage(e)}`;
  }
  lines.push(`Sync server: ${vault.server.url} ${remote}`);
  return lines;
}
