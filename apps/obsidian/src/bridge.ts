import { executeOp, handleOpRequest, OpError, type OpRequest, type OpResult } from "@provenance/core";
import { Platform, prepareSimpleSearch, type App } from "obsidian";
import { dailyNotesPlugin } from "./quirks";
import type { SyncEngine } from "./sync/engine";

/** How long a rename gets to finish before it counts as waiting on the human. */
const RENAME_SETTLE_MS = 2000;

/**
 * The full-mode half of the vault ops: things only a running Obsidian knows
 * (links, search, the daily note) or does better (renames that rewrite links, trash).
 */
async function runFull(app: App, engine: SyncEngine, req: OpRequest): Promise<OpResult> {
  const fileAt = (path: string) => {
    const f = app.vault.getFileByPath(path);
    if (!f) throw new OpError("not-found", `no such file: ${path}`);
    return f;
  };
  const links = app.metadataCache.resolvedLinks;
  switch (req.op) {
    case "rename": {
      if (app.vault.getAbstractFileByPath(req.to)) throw new OpError("exists", `file already exists: ${req.to}`);
      const file = fileAt(req.from);
      const dir = req.to.split("/").slice(0, -1).join("/");
      if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
      // Unless the vault always updates links, renameFile moves a linked note, then waits for the human to answer a dialog.
      const settled = await Promise.race([
        app.fileManager.renameFile(file, req.to).then(() => true),
        new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), RENAME_SETTLE_MS)),
      ]);
      if (!settled && file.path !== req.to) throw new OpError("unavailable", `the rename of ${req.from} has not finished`);
      return settled ? { op: "rename" } : { op: "rename", linksPending: true };
    }
    case "delete":
      await app.fileManager.trashFile(fileAt(req.path));
      return { op: "delete" };
    case "links":
      fileAt(req.path);
      return { op: "links", paths: Object.keys(links[req.path] ?? {}).sort() };
    case "backlinks":
      fileAt(req.path);
      return {
        op: "backlinks",
        paths: Object.entries(links)
          .filter(([, targets]) => req.path in targets)
          .map(([source]) => source)
          .sort(),
      };
    case "search": {
      const match = prepareSimpleSearch(req.query);
      const paths: string[] = [];
      for (const f of app.vault.getMarkdownFiles()) {
        if (match(f.path) || match(await app.vault.cachedRead(f))) paths.push(f.path);
        if (paths.length >= 50) break;
      }
      return { op: "search", paths };
    }
    case "daily": {
      const daily = dailyNotesPlugin(app);
      if (!daily?.getDailyNote) throw new OpError("unsupported", "Obsidian's Daily notes plugin is turned off");
      const file = await daily.getDailyNote();
      if (!file) throw new OpError("not-found", `could not open today's daily note; check that its folder exists: ${daily.options?.folder ?? "(vault root)"}`);
      return { op: "daily", path: file.path };
    }
    default:
      return executeOp(engine, req);
  }
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Localhost HTTP endpoint for the local MCP server. Desktop only: Node's http
 * module is loaded lazily so the plugin still loads on mobile. The port and a
 * per-launch token go to bridge.json in the plugin folder, which the MCP CLI
 * reads; the file is removed on unload.
 */
export async function startBridge(app: App, engine: SyncEngine, bridgeFile: string): Promise<() => Promise<void>> {
  if (!Platform.isDesktop) throw new Error("the agent bridge needs the desktop app");
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Obsidian provides require on desktop; loaded lazily so mobile never evaluates it
  const http = require("node:http") as typeof import("node:http");
  type IncomingMessage = InstanceType<typeof http.IncomingMessage>;
  type ServerResponse = InstanceType<typeof http.ServerResponse>;
  const token = randomToken();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/ops") return reply(404, { error: "not found" });
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "unauthorized" });
    let body = "";
    for await (const chunk of req) body += String(chunk);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(400, { error: "invalid JSON" });
    }
    reply(200, await handleOpRequest(engine, parsed, (op) => runFull(app, engine, op)));
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error("[provenance-sync] bridge", e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await app.vault.adapter.write(bridgeFile, JSON.stringify({ port, token }));

  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (await app.vault.adapter.exists(bridgeFile)) await app.vault.adapter.remove(bridgeFile);
  };
}
