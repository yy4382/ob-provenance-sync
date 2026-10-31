import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { OpRequest, OpResponse } from "@provenance/core";
import { describe, expect, it } from "vitest";
import { createMcpServer, type OpsTransport } from "../src";

async function connect(ops: OpsTransport, mode: "full" | "limited", agent: `agent:${string}` | null = "agent:claude-code", clientName = "test") {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ ops, agent, mode }).connect(a);
  const client = new Client({ name: clientName, version: "0" });
  await client.connect(b);
  return client;
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

  it("tells each mode only about tools it has, within what clients keep", async () => {
    const text = async (mode: "full" | "limited") => (await connect(async () => ({ ok: true, result: { op: "append" } }), mode)).getInstructions() ?? "";
    const [full, limited] = [await text("full"), await text("limited")];
    expect(full).toContain("get_daily_note");
    expect(limited).not.toMatch(/get_daily_note|get_links|search|Obsidian isn't running/);
    expect(full.length).toBeLessThan(4096);
  });

  it("prints a passage of no recorded author once, and keeps unknown among other authors", async () => {
    const sentences = [
      { text: "From disk.", kind: "unknown" as const, authors: ["unknown"] },
      { text: "Half half.", kind: "mixed" as const, authors: ["agent:claude-code", "unknown"] },
    ];
    const client = await connect(async () => ({ ok: true, result: { op: "read", content: "", sentences } }), "limited");
    const res = await client.callTool({ name: "read_file", arguments: { path: "a.md", provenance: true } });
    expect(res.content).toEqual([{ type: "text", text: "[unknown] From disk.\n[mixed agent:claude-code,unknown] Half half." }]);
  });

  it("rejects a multi-line note before it reaches the vault", async () => {
    const seen: OpRequest[] = [];
    const client = await connect(async (req) => (seen.push(req), { ok: true, result: { op: "append" } }), "limited");
    const res = await client.callTool({ name: "append_to_file", arguments: { path: "a.md", text: "x", why: "agent", note: "two\nlines" } });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("says when a rename left links waiting on the human", async () => {
    const answer = async (linksPending: boolean) => {
      const client = await connect(async () => ({ ok: true, result: { op: "rename", ...(linksPending ? { linksPending } : {}) } }), "full");
      return client.callTool({ name: "rename_file", arguments: { from: "a.md", to: "b.md" } });
    };
    expect((await answer(false)).content).toEqual([{ type: "text", text: "ok" }]);
    expect((await answer(true)).content).toEqual([{ type: "text", text: expect.stringMatching(/asking the human/) }]);
  });

  it("returns today's daily note path, and says when it isn't created yet", async () => {
    const answer = async (exists: boolean) => {
      const client = await connect(async () => ({ ok: true, result: { op: "daily", path: "Journal/2026-10-31.md", exists } }), "full");
      return client.callTool({ name: "get_daily_note", arguments: {} });
    };
    expect((await answer(true)).content).toEqual([{ type: "text", text: "Journal/2026-10-31.md" }]);
    expect((await answer(false)).content).toEqual([{ type: "text", text: "Journal/2026-10-31.md\n(not created yet)" }]);
  });

  it("creates the daily note only through its own tool", async () => {
    const seen: OpRequest[] = [];
    const ops: OpsTransport = async (req) => (seen.push(req), { ok: true, result: { op: "daily", path: "a.md", exists: true } });
    const client = await connect(ops, "full");
    await client.callTool({ name: "get_daily_note", arguments: {} });
    await client.callTool({ name: "create_daily_note", arguments: {} });
    expect(seen).toEqual([{ op: "daily" }, { op: "daily", create: true }]);
  });
});
