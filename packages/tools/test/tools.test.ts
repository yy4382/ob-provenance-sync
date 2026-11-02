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

  it("names the recent changes tool on every surface, in its own terms", () => {
    expect(instructions("cli")).toContain("use activities with --since <time>");
    expect(instructions("full")).toContain("use list_recent_changes with since=<time>");
    expect(instructions("limited")).toContain("use list_recent_changes with since=<time>");
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

  it("says when a read reaches past what's recorded for a note", () => {
    const at = Date.parse("2026-11-02T06:05:00Z");
    expect(render({ ok: true, result: { op: "read", content: "text", incomplete: "record", recordStart: at } }).text).toBe(`text\n\nnote: this note's history starts at ${stamp(at)}, so this is its earliest recorded text and it may have differed at that time.`);
    expect(render({ ok: true, result: { op: "read", content: "text", incomplete: "record" } }).text).toBe("text\n\nnote: nothing is recorded for this note, so this is its current text and it may have differed at that time.");
  });
});

describe("recent changes", () => {
  const at = Date.parse("2026-11-02T06:05:00Z");
  const time = stamp(at);
  const base = { at, authors: ["human:a" as const], path: "a.md", status: "modified" as const, added: 2, removed: 1, preview: "+ new - old" };
  const tool = TOOLS.find((t) => t.op === "activities")!;
  const answer = (result: object) => render({ ok: true, result: { op: "activities", changes: [], offsets: [], ...result } });

  it("prints one line per file, in the same form as a note's versions", () => {
    expect(
      answer({
        changes: [
          base,
          { ...base, path: "b.md", from: "a.md", status: "renamed", authors: ["unknown"], added: 0, removed: 0, preview: "" },
          { ...base, status: "deleted", added: 0, removed: 3, preview: "- gone" },
          { ...base, added: null, removed: null, preview: "" },
        ],
      }).text,
    ).toBe([`${time}  a.md  human:a  +2 -1  + new - old`, `${time}  a.md -> b.md  unknown  +0 -0`, `${time}  a.md (deleted)  human:a  +0 -3  - gone`, `${time}  a.md  human:a  +? -?`].join("\n"));
  });

  it("prints binary in place of an attachment's counts", () => {
    expect(answer({ changes: [{ ...base, path: "p.png", authors: ["unknown"], added: null, removed: null, preview: "", binary: true }] }).text).toBe(`${time}  p.png  unknown  binary`);
  });

  it("puts hunks under a file in place of its preview", () => {
    expect(answer({ changes: [{ ...base, diff: "@@ -1,1 +1,1 @@\n-old\n+new" }] }).text).toBe(`${time}  a.md  human:a  +2 -1\n@@ -1,1 +1,1 @@\n-old\n+new\n`);
  });

  it("says when nothing changed", () => {
    expect(answer({}).text).toBe("(no changes in this time)");
  });

  it("says what to pass next, what cut an answer short, and where the record starts", () => {
    expect(answer({ changes: [base], next_offset: 7 }).text).toBe(`${time}  a.md  human:a  +2 -1  + new - old\nnote: more changes exist. Pass offset 7 to see them.`);
    expect(answer({ incomplete: "server" }).text).toContain("other devices' changes may be missing");
    expect(answer({ incomplete: "time" }).text).toContain("older changes may be missing");
    expect(answer({ recordStart: at }).text).toBe(`(no changes in this time)\nnote: the record starts at ${time}, so nothing older is shown.`);
  });

  it("gives structured output that matches what the tool declares, with times stamped", () => {
    const { structured } = answer({ changes: [{ ...base, binary: true }], offsets: [3], next_offset: 4, incomplete: "time", recordStart: at });
    expect(structured).toEqual({ changes: [{ ...base, binary: true, at: time }], next_offset: 4, incomplete: "time", record_start: time });
    expect(tool.output!.safeParse(structured).success).toBe(true);
  });

  const capped = (changes: object[], result: object) =>
    runTool(tool, { since: "2h", full_diff: true }, { ops: async () => ({ ok: true, result: { op: "activities", changes, ...result } as never }), agent: null, noAgent: "", diffChars: MCP_DIFF_CHARS });

  it("resumes a capped page at the file after the cut, past files with no net change", async () => {
    const res = await capped(
      [{ ...base, diff: "a".repeat(20_000) }, { ...base, diff: "b".repeat(20_000) }, { ...base, diff: "c".repeat(20_000) }],
      { offsets: [10, 12, 15], next_offset: 16 },
    );
    expect(res.structured).toMatchObject({ next_offset: 15 });
    expect(res.text).toContain("Pass offset 15");
  });

  it("carries on after the page when the cut falls on its last file", async () => {
    const res = await capped([{ ...base, diff: "a".repeat(40_000) }], { offsets: [10], next_offset: 13 });
    expect(res.structured).toMatchObject({ next_offset: 13 });
    expect(await capped([{ ...base, diff: "a".repeat(40_000) }], { offsets: [10] }).then((r) => r.structured)).not.toHaveProperty("next_offset");
  });

  it("asks only for what it was given, and always for a time", () => {
    expect(tool.request({ since: "2026-11-02T14:05+08:00" } as never, "agent:x")).toEqual({ op: "activities", since: Date.parse("2026-11-02T14:05+08:00") });
    expect(tool.request({ since: "2026-11-02T14:05+08:00", authors: [], include_unknown: true } as never, "agent:x")).toEqual({ op: "activities", since: Date.parse("2026-11-02T14:05+08:00") });
    expect(tool.request({ since: "2026-11-02T14:05+08:00", authors: ["human:a"], include_unknown: false, limit: 5, offset: 2, full_diff: true } as never, "agent:x")).toEqual({
      op: "activities",
      since: Date.parse("2026-11-02T14:05+08:00"),
      authors: ["human:a"],
      skipUnknown: true,
      limit: 5,
      offset: 2,
      fullDiff: true,
    });
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
