import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage, FULL_ONLY_OPS, parseOpResponse, type OpRequest, type OpResponse } from "@provenance/core";
import type { OpsTransport } from "@provenance/tools";
import type { RegisteredVault, Selection } from "./vault";

const PLUGIN_ID = "provenance-sync";
const TIMEOUT_MS = 15_000;

const noAnswer = (timeoutMs: number): OpResponse => ({
  ok: false,
  code: "unavailable",
  message: `No answer within ${timeoutMs / 1000} seconds. A write may still land, so read the note before retrying.`,
});

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
      if (e instanceof Error && e.name === "TimeoutError") return noAnswer(timeoutMs);
      throw new Unreachable(`${url}: ${errorMessage(e)}`);
    }
    if (res.status === 401) return { ok: false, code: "unavailable", message: `${url} rejected the token` };
    try {
      return (await res.json()) as OpResponse;
    } catch {
      throw new Unreachable(`${url}: answered ${res.status} without a vault response`);
    }
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

/** The plugin's answer, or why there is none. `obsidian` exits 0 on most failures, so only a parsed response counts as an answer. */
export async function askObsidian(obsidian: string, vaultId: string, req: OpRequest, timeoutMs: number): Promise<OpResponse | string> {
  const dir = await mkdtemp(join(tmpdir(), "ob-provenance-"));
  const file = join(dir, "request.json");
  await writeFile(file, JSON.stringify(req), { mode: 0o600 });
  try {
    const r = await run(obsidian, [`vault=${vaultId}`, PLUGIN_ID, `request=${file}`], timeoutMs);
    if (r.timedOut) return noAnswer(timeoutMs);
    if (r.error?.code === "ENOENT") return "the obsidian command isn't on PATH. The human turns it on in Obsidian's settings, under General, Command line interface.";
    if (r.error) return r.error.message;
    return parseOpResponse(r.stdout) ?? ((r.code === 0 ? r.stdout : r.stderr).trim() || "it printed nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The plugin when Obsidian answers, otherwise the sync server's limited API.
 * Looked up on every call because Obsidian may start or quit during an agent
 * session. A timeout never moves on to the server: the first request may still
 * land, and the second would write the same text again.
 */
export function agentOps(opts: { select: () => Promise<Selection>; obsidian?: string; timeoutMs?: number }): OpsTransport {
  const { obsidian = "obsidian", timeoutMs = TIMEOUT_MS } = opts;
  return async (req) => {
    const selection = await opts.select();
    if (!selection.ok) return { ok: false, code: "invalid", message: selection.message };
    const { vault } = selection;
    const answer = await askObsidian(obsidian, vault.id, req, timeoutMs);
    if (typeof answer !== "string") return answer;
    if (FULL_ONLY_OPS.has(req.op)) return { ok: false, code: "unavailable", message: `This tool needs Obsidian running, and it didn't answer: ${answer}` };
    if (!vault.server) return { ok: false, code: "unavailable", message: `Obsidian didn't answer and this vault has no sync server: ${answer}` };
    try {
      return await remoteOps(vault.server, timeoutMs)(req);
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e;
      return { ok: false, code: "unavailable", message: `The vault is not available right now. Obsidian didn't answer (${answer}), and the sync server is unreachable.` };
    }
  };
}

/** What `status` shows: which way a call would go right now. */
export async function describeRoute(vault: RegisteredVault, obsidian = "obsidian", timeoutMs = TIMEOUT_MS): Promise<string[]> {
  const probe: OpRequest = { op: "list", prefix: "\0" };
  const local = await askObsidian(obsidian, vault.id, probe, timeoutMs);
  const lines = [`Vault: ${vault.name} (${vault.path})`, `Obsidian: ${typeof local === "string" ? `not reachable: ${local}` : "reachable"}`];
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
