import { FULL_ONLY_OPS, opRequestSchema, type OpName } from "@provenance/core";
import { describe, expect, it } from "vitest";
import { instructions, MCP_DIFF_CHARS, parseTime, recordsAuthor, render, runTool, stamp, TOOLS, toolsFor } from "../src";

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
    expect(cli).toContain("--agent <your name>");
    expect(cli).toContain("--why human-via-agent");
    expect(cli).toContain("--provenance");
    expect(cli).not.toMatch(/\b(agent|vault|why|path|provenance)=/);
    expect(instructions("full")).toContain("edit_file");
    expect(instructions("full")).toContain("why=human-via-agent");
    expect(instructions("full")).not.toContain("--agent");
  });
});

describe("parseTime", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");

  it("reads a span as that long ago", () => {
    expect(parseTime("30m", now)).toBe(now - 30 * 60_000);
    expect(parseTime("2h", now)).toBe(now - 2 * 3_600_000);
    expect(parseTime("1d", now)).toBe(now - 86_400_000);
    expect(parseTime("1w", now)).toBe(now - 7 * 86_400_000);
  });

  it("reads an ISO time with its offset, and one without as local", () => {
    expect(parseTime("2026-11-02T14:05+08:00", now)).toBe(Date.parse("2026-11-02T06:05:00Z"));
    expect(parseTime("2026-11-02T14:05:30.5Z", now)).toBe(Date.parse("2026-11-02T14:05:30.5Z"));
    expect(parseTime("2026-11-02T14:05", now)).toBe(new Date(2026, 10, 2, 14, 5).getTime());
  });

  it("reads a date alone as local midnight, which Date.parse would take for UTC", () => {
    expect(parseTime("2026-11-02", now)).toBe(new Date(2026, 10, 2).getTime());
  });

  it("refuses anything else, including a day the month doesn't have", () => {
    for (const raw of ["", "yesterday", "2h ago", "5", "2026-02-31", "2026-13-01", "2026-11-02T25:00", "1793599500000"]) expect(parseTime(raw, now), raw).toBeNull();
  });

  it("reads back every time it prints", () => {
    const at = Date.parse("2026-11-02T06:05:00Z");
    expect(stamp(at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(parseTime(stamp(at), now)).toBe(at);
  });
});

describe("a note's history", () => {
  const at = Date.parse("2026-11-02T06:05:00Z");
  const base = { at, authors: ["human:a" as const], path: "a.md", status: "modified" as const, added: 2, removed: 1, preview: "+ new - old" };
  const answer = (result: object) => render({ ok: true, result: { op: "history", versions: [], ...result } });
  const time = stamp(at);

  it("prints one line per version, with two spaces between fields", () => {
    expect(
      answer({
        versions: [
          base,
          { ...base, path: "b.md", from: "a.md", status: "renamed", authors: ["unknown"], added: 0, removed: 0, preview: "" },
          { ...base, status: "created", preview: "+ hello" },
          { ...base, status: "deleted", authors: ["human:a", "unknown"], added: null, removed: null, preview: "" },
        ],
      }).text,
    ).toBe([`${time}  a.md  human:a  +2 -1  + new - old`, `${time}  a.md -> b.md  unknown  +0 -0`, `${time}  a.md (new)  human:a  +2 -1  + hello`, `${time}  a.md (deleted)  human:a,unknown  +? -?`].join("\n"));
  });

  it("puts hunks under a version in place of its preview", () => {
    expect(answer({ versions: [{ ...base, diff: "@@ -1 +1 @@\n-old\n+new" }] }).text).toBe(`${time}  a.md  human:a  +2 -1\n@@ -1 +1 @@\n-old\n+new\n`);
  });

  it("says when there's nothing to show", () => {
    expect(answer({}).text).toBe("(no recorded changes)");
  });

  it("says what to pass next, and what cut an answer short", () => {
    expect(answer({ versions: [base], next_offset: 20 }).text).toContain("Pass offset 20");
    expect(answer({ versions: [base], incomplete: "server" }).text).toContain("Older history needs the sync server");
    expect(answer({ versions: [base], incomplete: "time" }).text).toContain("time limit");
  });

  it("gives structured output a time that can be passed back as at", () => {
    const { structured } = answer({ versions: [base], next_offset: 1, incomplete: "time" });
    expect(structured).toEqual({ versions: [{ ...base, at: time }], next_offset: 1, incomplete: "time" });
    expect(TOOLS.find((t) => t.op === "history")!.output!.safeParse(structured).success).toBe(true);
  });

  it("flags a read that can't be sure", () => {
    expect(render({ ok: true, result: { op: "read", content: "text", incomplete: "server" } }).text).toBe("text\n\nnote: the sync server can't be reached and older history needs it, so this may not be the text at that time.");
  });
});

describe("capping full diffs", () => {
  const version = (diff: string) => ({ at: 0, authors: [], path: "a.md", status: "modified" as const, added: 1, removed: 0, preview: "", diff });
  const history = TOOLS.find((t) => t.op === "history")!;
  const run = (versions: object[], args: object = {}) =>
    runTool(history, { path: "a.md", full_diff: true, ...args }, { ops: async () => ({ ok: true, result: { op: "history", versions } as never }), agent: null, noAgent: "", diffChars: MCP_DIFF_CHARS });

  it("leaves an answer under the cap alone", async () => {
    const res = await run([version("x".repeat(100))]);
    expect(res.text).not.toContain("note:");
    expect(res.structured).toMatchObject({ versions: [{ diff: "x".repeat(100) }] });
    expect(res.structured).not.toHaveProperty("next_offset");
  });

  it("cuts where the cap falls, marks what was cut, and says where to go on", async () => {
    const res = await run([version("a".repeat(20_000)), version("b".repeat(20_000)), version("c".repeat(20_000))], { offset: 5 });
    const { versions, next_offset } = res.structured as { versions: Array<{ diff?: string; truncated?: boolean }>; next_offset: number };
    expect(versions[0]!.truncated).toBeUndefined();
    expect(versions[1]).toMatchObject({ diff: "b".repeat(10_000), truncated: true });
    expect(versions[2]).toMatchObject({ truncated: true });
    expect(versions[2]!.diff).toBeUndefined();
    expect(versions.reduce((n, v) => n + (v.diff?.length ?? 0), 0)).toBe(MCP_DIFF_CHARS);
    expect(next_offset).toBe(7);
    expect(res.text).toContain("Pass offset 7");
    expect(res.text).toContain("read the note at its time");
  });
});

describe("runTool", () => {
  const append = TOOLS.find((t) => t.op === "append")!;
  const args = { path: "a.md", text: "x", why: "agent" };

  it("refuses to write without an identity and never reaches the vault", async () => {
    let called = false;
    const ops = async () => ((called = true), { ok: true as const, result: { op: "append" as const } });
    expect(recordsAuthor(append)).toBe(true);
    expect(await runTool(append, args, { ops, agent: null, noAgent: "name yourself" })).toEqual({ isError: true, code: "invalid", text: "invalid: name yourself" });
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
