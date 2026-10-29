import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  attribute,
  fileDocName,
  humanProvenance,
  indexDocName,
  insertText,
  newFileId,
  TEXT_KEY,
  VaultIndex,
  type FileId,
} from "@provenance/core";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createApp } from "../src/app";
import { parseConfig } from "../src/config";

const DEVICE_A = "device-a-token-0123456789";
const DEVICE_B = "device-b-token-0123456789";
const ANDY = "agent-andy-token-01234567";
const ANY_AGENT = "agent-any-token-012345678";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function start(dataDir?: string) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), "prov-server-")));
  const app = createApp(
    parseConfig({
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      tokens: [
        { role: "device", name: "mac", token: DEVICE_A },
        { role: "device", name: "phone", token: DEVICE_B },
        { role: "agent", name: "andy", token: ANDY, agent: "agent:andy" },
        { role: "agent", name: "sessions", token: ANY_AGENT },
      ],
    }),
  );
  const server = await app.listen();
  const http = `http://127.0.0.1:${server.address.port}`;
  return { app, dir, http, ws: http.replace("http", "ws"), close: () => app.close() };
}

function connect(ws: string, name: string, token: string) {
  const document = new Y.Doc({ gc: false });
  const provider = new HocuspocusProvider({ url: ws, name, token, document });
  cleanup.push(() => provider.destroy());
  return {
    document,
    provider,
    synced: () => new Promise<void>((resolve, reject) => {
      if (provider.isSynced) return resolve();
      provider.on("synced", () => resolve());
      provider.on("authenticationFailed", ({ reason }: { reason: string }) => reject(new Error(reason)));
    }),
  };
}

async function eventually(check: () => void, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return check();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

const post = (url: string, token: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then(
    async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }),
  );

describe("sync server", () => {
  it("syncs attributed text between two devices and persists it across restarts", async () => {
    const s = await start();
    const id = newFileId();
    const a = connect(s.ws, fileDocName("v", id), DEVICE_A);
    const b = connect(s.ws, fileDocName("v", id), DEVICE_B);
    await Promise.all([a.synced(), b.synced()]);

    insertText(a.document.getText(TEXT_KEY), 0, "Typed on the mac.", humanProvenance("human:chris", "mac"));
    await eventually(() => expect(b.document.getText(TEXT_KEY).toString()).toBe("Typed on the mac."));
    expect(attribute(b.document.getText(TEXT_KEY))[0]).toMatchObject({ kind: "human", contributors: [{ author: "human:chris", device: "mac" }] });

    a.provider.destroy();
    b.provider.destroy();
    await new Promise((r) => setTimeout(r, 100));
    await s.close();

    const again = await start(s.dir);
    cleanup.push(again.close);
    const c = connect(again.ws, fileDocName("v", id), DEVICE_A);
    await c.synced();
    expect(c.document.getText(TEXT_KEY).toString()).toBe("Typed on the mac.");
  });

  it("rejects unknown tokens and agent tokens on the sync socket", async () => {
    const s = await start();
    cleanup.push(s.close);
    await expect(connect(s.ws, indexDocName("v"), "nope-nope-nope-nope").synced()).rejects.toThrow();
    await expect(connect(s.ws, indexDocName("v"), ANDY).synced()).rejects.toThrow();
  });

  it("applies agent ops from the HTTP API to connected devices", async () => {
    const s = await start();
    cleanup.push(s.close);
    const index = connect(s.ws, indexDocName("v"), DEVICE_A);
    await index.synced();

    const created = await post(`${s.http}/api/vaults/v/ops`, ANDY, {
      op: "create",
      path: "daily/today.md",
      content: "Andy noticed the deadline moved.",
      by: { agent: "agent:someone-else", why: "agent", note: "from the team chat" },
    });
    expect(created).toEqual({ status: 200, body: { ok: true, result: { op: "create" } } });

    let id!: FileId;
    await eventually(() => expect((id = new VaultIndex(index.document).idOf("daily/today.md")!)).toBeTruthy());
    const file = connect(s.ws, fileDocName("v", id), DEVICE_A);
    await file.synced();
    expect(attribute(file.document.getText(TEXT_KEY))[0]!.contributors[0]).toMatchObject({
      author: "agent:andy",
      why: "agent",
      note: "from the team chat",
      device: "server",
    });

    expect((await post(`${s.http}/api/vaults/v/ops`, ANDY, { op: "backlinks", path: "daily/today.md" })).body).toMatchObject({
      ok: false,
      code: "unsupported",
    });
    expect((await post(`${s.http}/api/vaults/v/ops`, "bad-token-bad-token", { op: "list" })).status).toBe(401);
  });

  it("answers malformed op requests as invalid, not as a server error", async () => {
    const s = await start();
    cleanup.push(s.close);
    for (const body of [null, "list", { op: "append", path: "a.md", text: "x", by: "agent:andy" }]) {
      expect(await post(`${s.http}/api/vaults/v/ops?agent=x`, ANY_AGENT, body)).toMatchObject({ status: 200, body: { ok: false, code: "invalid" } });
    }
  });

  it("serves the limited MCP toolset over HTTP", async () => {
    const s = await start();
    cleanup.push(s.close);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.http}/mcp/v?agent=claude-code`), {
        requestInit: { headers: { authorization: `Bearer ${ANY_AGENT}` } },
      }),
    );
    cleanup.push(() => client.close());
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("get_backlinks");
    await client.callTool({ name: "create_file", arguments: { path: "a.md", content: "Hi.", why: "agent" } });
    const read = await client.callTool({ name: "read_file", arguments: { path: "a.md", provenance: true } });
    expect(read.content).toEqual([{ type: "text", text: "[agent agent:claude-code] Hi." }]);
  });

  it("stores attachments by content hash", async () => {
    const s = await start();
    cleanup.push(s.close);
    const data = Buffer.from("png bytes");
    const hash = createHash("sha256").update(data).digest("hex");
    const url = `${s.http}/api/vaults/v/blobs/${hash}`;
    const auth = { authorization: `Bearer ${DEVICE_A}` };
    expect((await fetch(url, { method: "PUT", headers: auth, body: Buffer.from("tampered") })).status).toBe(400);
    expect((await fetch(url, { method: "PUT", headers: auth, body: data })).status).toBe(200);
    expect(Buffer.from(await (await fetch(url, { headers: auth })).arrayBuffer())).toEqual(data);
    expect((await fetch(url, { headers: { authorization: `Bearer ${ANDY}` } })).status).toBe(403);
  });
});
