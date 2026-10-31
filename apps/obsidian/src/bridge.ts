import { handleOpRequest } from "@provenance/core";
import { Platform, type App } from "obsidian";
import { runFull } from "./agent-ops";
import type { SyncEngine } from "./sync/engine";

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
