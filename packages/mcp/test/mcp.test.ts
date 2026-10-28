import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { OpRequest, OpResponse } from "@provenance/core";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer, httpOps, localOps, PLUGIN_ID, type OpsTransport } from "../src";

async function connect(ops: OpsTransport, mode: "full" | "limited", agent: `agent:${string}` | null = "agent:claude-code", clientName = "test") {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ ops, agent, mode }).connect(a);
  const client = new Client({ name: clientName, version: "0" });
  await client.connect(b);
  return client;
}

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

async function fakeHost(answer: (req: OpRequest) => OpResponse) {
  const seen: OpRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const op = JSON.parse(body) as OpRequest;
      seen.push(op);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer(op)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => server.close());
  return { port: (server.address() as AddressInfo).port, seen };
}

describe("MCP tools", () => {
  it("requires a why and stamps the agent identity on edits", async () => {
    const seen: OpRequest[] = [];
    const client = await connect(async (req) => (seen.push(req), { ok: true, result: { op: "edit", replaced: 1 } }), "limited");
    const missingWhy = await client.callTool({ name: "edit_file", arguments: { path: "a.md", old_string: "x", new_string: "y" } });
    expect(missingWhy.isError).toBe(true);
    const ok = await client.callTool({
      name: "edit_file",
      arguments: { path: "a.md", old_string: "x", new_string: "y", why: "human-via-agent", note: "dictated" },
    });
    expect(ok.content).toEqual([{ type: "text", text: "replaced 1 occurrence(s)" }]);
    expect(seen[0]).toMatchObject({ op: "edit", by: { agent: "agent:claude-code", why: "human-via-agent", note: "dictated" } });
  });

  it("names the agent after the MCP client unless the server pins an identity", async () => {
    const seen: OpRequest[] = [];
    const ops: OpsTransport = async (req) => (seen.push(req), { ok: true, result: { op: "append" } });
    const args = { path: "a.md", text: "x", why: "agent" };
    await (await connect(ops, "full", null, "Claude Code")).callTool({ name: "append_to_file", arguments: args });
    await (await connect(ops, "full", null, "codex-mcp-client")).callTool({ name: "append_to_file", arguments: args });
    await (await connect(ops, "full", "agent:andy", "codex-mcp-client")).callTool({ name: "append_to_file", arguments: args });
    expect(seen.map((r) => r.op === "append" && r.by.agent)).toEqual(["agent:claude-code", "agent:codex-mcp-client", "agent:andy"]);
  });

  it("limited mode only offers the edit and read tools", async () => {
    const names = async (mode: "full" | "limited") =>
      (await (await connect(async () => ({ ok: true, result: { op: "append" } }), mode)).listTools()).tools.map((t) => t.name).sort();
    expect(await names("limited")).toEqual(["append_to_file", "create_file", "edit_file", "list_files", "read_file"]);
    expect(await names("full")).toContain("get_backlinks");
  });
});

describe("localOps", () => {
  it("prefers the running plugin's bridge", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "vault-"));
    const host = await fakeHost(() => ({ ok: true, result: { op: "links", paths: ["b.md"] } }));
    const dir = join(vaultPath, ".custom-config", "plugins", PLUGIN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bridge.json"), JSON.stringify({ port: host.port, token: "t" }));
    const res = await localOps({ vaultPath, remote: null })({ op: "links", path: "a.md" });
    expect(res).toEqual({ ok: true, result: { op: "links", paths: ["b.md"] } });
  });

  it("falls back to the server when Obsidian is closed, and says so when both are down", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "vault-"));
    const host = await fakeHost(() => ({ ok: true, result: { op: "list", files: ["a.md"] } }));
    const remote = httpOps(`http://127.0.0.1:${host.port}/api/vaults/v/ops`, "t");
    expect(await localOps({ vaultPath, remote })({ op: "list" })).toMatchObject({ ok: true });
    expect(await localOps({ vaultPath, remote })({ op: "backlinks", path: "a.md" })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/needs Obsidian/),
    });
    const dead = httpOps("http://127.0.0.1:9/api/vaults/v/ops", "t");
    expect(await localOps({ vaultPath, remote: dead })({ op: "list" })).toMatchObject({
      ok: false,
      code: "unavailable",
      message: expect.stringMatching(/not available right now/),
    });
  });
});
