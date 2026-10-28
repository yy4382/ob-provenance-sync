import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Database } from "@hocuspocus/extension-database";
import { Server } from "@hocuspocus/server";
import { executeOp, FULL_ONLY_OPS, handleOpRequest, OpError, parseDocName, type OpRequest } from "@provenance/core";
import { createMcpServer, serveMcpHttp } from "@provenance/mcp";
import { agentFor, credentialFor, type Config, type Credential } from "./config";
import { ServerVaultDocs } from "./docs";
import { Storage } from "./storage";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await readBody(req, 10 * 1024 * 1024)).toString("utf8"));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "invalid JSON body");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Server-side ops are the limited set; the rest need a running Obsidian. */
async function runLimited(docs: ServerVaultDocs, req: OpRequest) {
  if (FULL_ONLY_OPS.has(req.op)) throw new OpError("unsupported", `${req.op} needs Obsidian running (full mode)`);
  return executeOp(docs, req);
}

export function createApp(config: Config) {
  const storage = new Storage(config.dataDir);

  const server = new Server({
    address: config.host,
    port: config.port,
    quiet: true,
    stopOnSignals: false,
    // History is the point of this project, so never discard deleted content.
    yDocOptions: { gc: false, gcFilter: () => false },
    extensions: [
      new Database({
        fetch: async ({ documentName }) => storage.loadDocument(documentName),
        store: async ({ documentName, state }) => storage.storeDocument(documentName, state),
      }),
    ],
    async onAuthenticate({ token, documentName }) {
      const cred = credentialFor(config, token);
      if (cred?.role !== "device") throw new Error("unauthorized");
      if (!parseDocName(documentName)) throw new Error(`invalid document name: ${documentName}`);
      return { device: cred.name };
    },
    async onRequest({ request, response }) {
      const url = new URL(request.url ?? "/", "http://localhost");
      const route = routes.find((r) => r.pattern.test(url.pathname));
      if (!route) return;
      try {
        const cred = credentialFor(config, bearer(request));
        if (!cred) throw new HttpError(401, "unauthorized");
        await route.handle(request, response, cred, url, route.pattern.exec(url.pathname)!.slice(1).map(decodeURIComponent));
      } catch (e) {
        if (!response.headersSent) {
          if (e instanceof HttpError) send(response, e.status, { error: e.message });
          else {
            console.error(e);
            send(response, 500, { error: "internal error" });
          }
        }
      }
      // Rejecting with a falsy value tells Hocuspocus the request was handled.
      throw null;
    },
  });

  type Handler = (req: IncomingMessage, res: ServerResponse, cred: Credential, url: URL, params: string[]) => Promise<void>;
  const routes: Array<{ pattern: RegExp; handle: Handler }> = [
    {
      pattern: /^\/api\/vaults\/([^/]+)\/ops$/,
      async handle(req, res, cred, url, [vault]) {
        if (req.method !== "POST") throw new HttpError(405, "POST only");
        const body = (await readJson(req)) as { by?: { agent?: string } };
        const agent = agentFor(cred, body.by?.agent ?? url.searchParams.get("agent"));
        if (cred.role === "agent" && body.by) {
          if (!agent) throw new HttpError(403, "this token needs a valid agent name");
          body.by.agent = agent;
        }
        const docs = new ServerVaultDocs(server.hocuspocus, vault!);
        try {
          send(res, 200, await handleOpRequest(docs, body, (op) => runLimited(docs, op)));
        } finally {
          await docs.close();
        }
      },
    },
    {
      pattern: /^\/api\/vaults\/([^/]+)\/blobs\/([0-9a-f]{64})$/,
      async handle(req, res, cred, _url, [vault, hash]) {
        if (cred.role !== "device") throw new HttpError(403, "device token required");
        if (req.method === "GET") {
          const data = storage.loadBlob(vault!, hash!);
          if (!data) throw new HttpError(404, "no such blob");
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(data);
        } else if (req.method === "PUT") {
          const data = await readBody(req, config.maxBlobBytes);
          if (createHash("sha256").update(data).digest("hex") !== hash) throw new HttpError(400, "hash mismatch");
          storage.storeBlob(vault!, hash!, data);
          send(res, 200, { ok: true });
        } else throw new HttpError(405, "GET or PUT only");
      },
    },
    {
      pattern: /^\/mcp\/([^/]+)$/,
      async handle(req, res, cred, url, [vault]) {
        const agent = agentFor(cred, url.searchParams.get("agent"));
        if (!agent) throw new HttpError(403, "an agent token is required; unpinned tokens also need ?agent=<name>");
        const body = req.method === "POST" ? await readJson(req) : undefined;
        const mcp = createMcpServer({
          agent,
          mode: "limited",
          ops: async (op) => {
            const docs = new ServerVaultDocs(server.hocuspocus, vault!);
            try {
              return await handleOpRequest(docs, op, (r) => runLimited(docs, r));
            } finally {
              await docs.close();
            }
          },
        });
        await serveMcpHttp(req, res, body, mcp);
      },
    },
  ];

  return {
    server,
    storage,
    async listen() {
      await server.listen();
      return server;
    },
    async close() {
      await server.destroy();
      storage.close();
    },
  };
}
