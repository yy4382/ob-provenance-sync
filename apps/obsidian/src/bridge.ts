import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { executeOp, handleOpRequest, OpError, type OpRequest, type OpResult } from "@provenance/core";
import { prepareSimpleSearch, type App } from "obsidian";
import type { SyncEngine } from "./sync/engine";

/**
 * The full-mode half of the vault ops: things only a running Obsidian knows
 * (links, search) or does better (renames that rewrite links, trash).
 */
async function runFull(app: App, engine: SyncEngine, req: OpRequest): Promise<OpResult> {
  const fileAt = (path: string) => {
    const f = app.vault.getFileByPath(path);
    if (!f) throw new OpError("not-found", `no such file: ${path}`);
    return f;
  };
  const links = app.metadataCache.resolvedLinks;
  switch (req.op) {
    case "rename":
      if (app.vault.getAbstractFileByPath(req.to)) throw new OpError("exists", `file already exists: ${req.to}`);
      await app.fileManager.renameFile(fileAt(req.from), req.to);
      return { op: "rename" };
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only module, must not load on mobile
  const http = require("node:http") as typeof import("node:http");
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

  const server: Server = http.createServer((req, res) => {
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
