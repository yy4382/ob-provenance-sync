import { FULL_ONLY_OPS, opRequestSchema, type OpName } from "@provenance/core";
import { describe, expect, it } from "vitest";
import { instructions, recordsAuthor, runTool, TOOLS, toolsFor } from "../src";

const ops = opRequestSchema.options.map((o) => o.shape.op.value as OpName);

describe("TOOLS", () => {
  it("names every tool once on each surface and reaches every op", () => {
    expect(new Set(TOOLS.map((t) => t.mcpName)).size).toBe(TOOLS.length);
    expect(new Set(TOOLS.map((t) => t.command)).size).toBe(TOOLS.length);
    expect(new Set(TOOLS.map((t) => t.op))).toEqual(new Set(ops));
  });

  it("offers only what a host without Obsidian can do in limited mode", () => {
    expect(toolsFor("limited").map((t) => t.op)).toEqual(ops.filter((op) => !FULL_ONLY_OPS.has(op)));
    expect(toolsFor("full")).toEqual(TOOLS);
  });
});

describe("instructions", () => {
  it("speaks the CLI's command names on the CLI, and MCP's over MCP", () => {
    const cli = instructions("cli");
    for (const t of TOOLS) if (t.mcpName !== t.command) expect(cli).not.toContain(t.mcpName);
    expect(cli).toContain("agent=<your name>");
    expect(instructions("full")).toContain("edit_file");
    expect(instructions("full")).not.toContain("agent=<your name>");
  });
});

describe("runTool", () => {
  const append = TOOLS.find((t) => t.op === "append")!;
  const args = { path: "a.md", text: "x", why: "agent" };

  it("refuses to write without an identity and never reaches the vault", async () => {
    let called = false;
    const ops = async () => ((called = true), { ok: true as const, result: { op: "append" as const } });
    expect(recordsAuthor(append)).toBe(true);
    expect(await runTool(append, args, { ops, agent: null, noAgent: "name yourself" })).toEqual({ isError: true, text: "invalid: name yourself" });
    expect(called).toBe(false);
  });

  it("stamps the identity on the request", async () => {
    const seen: unknown[] = [];
    const ops = async (req: unknown) => (seen.push(req), { ok: true as const, result: { op: "append" as const } });
    expect(await runTool(append, args, { ops, agent: "agent:cli", noAgent: "" })).toEqual({ isError: false, text: "ok" });
    expect(seen).toEqual([{ op: "append", path: "a.md", text: "x", by: { agent: "agent:cli", why: "agent" } }]);
  });

  it("reads without an identity", async () => {
    const list = TOOLS.find((t) => t.op === "list")!;
    const ops = async () => ({ ok: true as const, result: { op: "list" as const, files: [] } });
    expect(await runTool(list, {}, { ops, agent: null, noAgent: "" })).toEqual({ isError: false, text: "(no files)" });
  });
});
