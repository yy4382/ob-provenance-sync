import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, FULL_ONLY_OPS, type OpResponse } from "@provenance/core";
import { z } from "zod";
import type { OpsTransport } from "./server";

export const PLUGIN_ID = "provenance-sync";

/** Thrown when the far end can't be reached at all, as opposed to answering with an error. */
export class Unreachable extends Error {}

export function httpOps(url: string, token: string): OpsTransport {
  return async (req) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
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

const bridgeFileSchema = z.object({ port: z.number().int(), token: z.string() });

/**
 * The plugin writes bridge.json into its own folder while Obsidian runs. The
 * config folder name is user-configurable, so look in every dot-folder.
 */
export async function findBridge(vaultPath: string): Promise<{ url: string; token: string } | null> {
  const entries = await readdir(vaultPath, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(".")) continue;
    const raw = await readFile(join(vaultPath, e.name, "plugins", PLUGIN_ID, "bridge.json"), "utf8").catch(() => null);
    const parsed = raw ? bridgeFileSchema.safeParse(JSON.parse(raw)) : null;
    if (parsed?.success) return { url: `http://127.0.0.1:${parsed.data.port}/ops`, token: parsed.data.token };
  }
  return null;
}

/**
 * Local mode: talk to the running plugin, and fall back to the sync server's
 * limited API when Obsidian is closed. The bridge is looked up on every call
 * because Obsidian may start or quit while the agent session lives on.
 */
export function localOps(opts: { vaultPath: string; remote: OpsTransport | null }): OpsTransport {
  return async (req) => {
    const bridge = await findBridge(opts.vaultPath);
    if (bridge) {
      try {
        return await httpOps(bridge.url, bridge.token)(req);
      } catch (e) {
        if (!(e instanceof Unreachable)) throw e;
      }
    }
    if (FULL_ONLY_OPS.has(req.op)) {
      return { ok: false, code: "unavailable", message: `${req.op} needs Obsidian running, and it is not` };
    }
    if (!opts.remote) {
      return { ok: false, code: "unavailable", message: "Obsidian is not running and no sync server is configured" };
    }
    try {
      return await opts.remote(req);
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e;
      return unavailable;
    }
  };
}

const unavailable: OpResponse = {
  ok: false,
  code: "unavailable",
  message: "The vault is not available right now: Obsidian is not running and the sync server is unreachable.",
};
