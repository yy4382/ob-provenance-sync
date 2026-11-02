import { instructions, TOOLS, type ToolDef } from "@provenance/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram, type Target } from "../src/program";

afterEach(() => void vi.restoreAllMocks());

async function run(...argv: string[]) {
  return runWith("from stdin\n", ...argv);
}

async function runWith(stdin: string, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((stderr += String(s)), true));
  const calls: { t: ToolDef; input: unknown; target: Target }[] = [];
  const program = buildProgram({
    stdin: async () => stdin,
    tool: async (t, input, target) => void calls.push({ t, input, target }),
    vaults: async () => {},
    status: async () => {},
    mcp: async () => {},
  });
  const error = await program.parseAsync(argv, { from: "user" }).then(
    () => null,
    (e: { code: string; exitCode: number }) => e,
  );
  vi.restoreAllMocks();
  return { call: calls[0], error, stdout, stderr };
}

/** What a shell would pass for an example: quotes group words, and a `<` redirect isn't an argument. */
const words = (example: string) => example.split(" < ")[0]!.match(/\$'[^']*'|"[^"]*"|\S+/g)!.map((w) => w.replace(/^\$'|^"|'$|"$/g, ""));

describe("ob-provenance arguments", () => {
  it("takes --vault and --agent before or after the command", async () => {
    expect((await run("--vault", "Notes", "--agent", "a", "list")).call?.target).toMatchObject({ vault: "Notes", agent: "a" });
    expect((await run("list", "--vault", "Notes", "--agent", "a")).call?.target).toMatchObject({ vault: "Notes", agent: "a" });
  });

  it("refuses two different values for --vault or --agent on either side of the command", async () => {
    expect((await run("--vault", "Work", "list", "--vault", "Personal")).error?.code).toBe("commander.error");
    expect((await run("--agent", "a", "append", "--path", "a.md", "--text", "x", "--why", "agent", "--agent", "b")).error?.code).toBe("commander.error");
    expect((await run("--vault", "Work", "--vault", "Personal", "list")).error?.code).toBe("commander.invalidArgument");
    expect((await run("--vault", "Work", "list", "--vault", "Work")).call?.target).toMatchObject({ vault: "Work" });
  });

  it("keeps stdin as it is, except for the line break ending an edit's string", async () => {
    expect((await runWith("a\n", "append", "--path", "a.md", "--stdin", "text", "--why", "agent")).call?.input).toMatchObject({ text: "a\n" });
    expect((await runWith("a\n\n", "edit", "--path", "a.md", "--old_string", "x", "--stdin", "new_string", "--why", "agent")).call?.input).toMatchObject({ new_string: "a\n" });
    expect((await runWith("a\r\n", "edit", "--path", "a.md", "--new_string", "x", "--stdin", "old_string", "--why", "agent")).call?.input).toMatchObject({ old_string: "a" });
  });

  it("refuses stdin that would quietly lose text", async () => {
    for (const text of ["", "\n"]) {
      const { call, stderr } = await runWith(text, "edit", "--path", "a.md", "--old_string", "x", "--stdin", "new_string", "--why", "agent");
      expect(call).toBeUndefined();
      expect(stderr).toContain('--new_string ""');
    }
    const both = await run("append", "--path", "a.md", "--stdin", "text", "--text", "x", "--why", "agent");
    expect(both.call).toBeUndefined();
    expect(both.stderr).toContain("both give text");
    const twice = await run("edit", "--path", "a.md", "--stdin", "old_string", "--stdin", "new_string", "--why", "agent");
    expect(twice.call).toBeUndefined();
    expect(twice.stderr).toContain("Only one field can come from stdin");
  });

  it("refuses an empty --vault or --agent, which is usually an unset variable", async () => {
    for (const flag of ["--vault", "--agent"]) {
      const { call, error } = await run(flag, "", "list");
      expect(call).toBeUndefined();
      expect(error?.code).toBe("commander.invalidArgument");
    }
    expect((await run("list", "--vault", "")).error?.code).toBe("commander.invalidArgument");
  });

  it("keeps a field's value even when it looks like an option", async () => {
    const { call } = await run("edit", "--path", "a.md", "--old_string", "--vault", "--new_string", "-h", "--why", "agent", "--vault", "Notes");
    expect(call?.input).toMatchObject({ old_string: "--vault", new_string: "-h" });
    expect(call?.target.vault).toBe("Notes");
  });

  it("accepts an empty value and a bare boolean", async () => {
    expect((await run("edit", "--path", "a.md", "--old_string", "x", "--new_string", "", "--why", "agent", "--replace_all")).call?.input).toMatchObject({ new_string: "", replace_all: true });
  });

  it("fills a required field from stdin", async () => {
    expect((await run("create", "--path", "a.md", "--why", "agent", "--stdin", "content")).call?.input).toMatchObject({ content: "from stdin\n" });
  });

  it("refuses --stdin for a field the command doesn't have", async () => {
    const { call, error } = await run("create", "--path", "a.md", "--why", "agent", "--stdin", "txet");
    expect(call).toBeUndefined();
    expect(error?.code).toBe("commander.invalidArgument");
  });

  it("names a missing field and where to look, without running the tool", async () => {
    const { call, error, stderr } = await run("read");
    expect(call).toBeUndefined();
    expect(error?.exitCode).toBe(1);
    expect(stderr).toContain("path");
    expect(stderr).toContain("See: ob-provenance read --help");
  });

  it("suggests the right flag and command for a typo", async () => {
    expect((await run("read", "--pth", "a.md")).stderr).toContain("--path");
    expect((await run("reed")).stderr).toContain("read");
  });

  it("refuses the key=value form instead of ignoring it", async () => {
    const { call, error } = await run("list", "prefix=a/");
    expect(call).toBeUndefined();
    expect(error?.code).toBe("commander.excessArguments");
  });
});

describe("ob-provenance history", () => {
  it("turns its flags into the tool's input", async () => {
    const { call } = await run("history", "--path", "a.md", "--limit", "5", "--offset", "10", "--diff");
    expect(call?.input).toEqual({ path: "a.md", limit: 5, offset: 10, full_diff: true });
    expect(call?.t.request(call.input as never, "agent:x")).toEqual({ op: "history", path: "a.md", limit: 5, offset: 10, fullDiff: true });
  });

  it("asks for nothing it wasn't given", async () => {
    const { call } = await run("history", "--path", "a.md");
    expect(call?.t.request(call.input as never, "agent:x")).toEqual({ op: "history", path: "a.md" });
  });

  it("refuses a limit that isn't a number", async () => {
    const { call, stderr } = await run("history", "--path", "a.md", "--limit", "many");
    expect(call).toBeUndefined();
    expect(stderr).toContain("whole number");
  });

  it("offers --json only where a tool declares its output", async () => {
    expect((await run("history", "--path", "a.md", "--json")).call?.target.json).toBe(true);
    expect((await run("list", "--json")).error?.code).toBe("commander.unknownOption");
  });
});

describe("ob-provenance read --at", () => {
  it("turns a time into the moment it names", async () => {
    const { call } = await run("read", "--path", "a.md", "--at", "2026-11-02T14:05+08:00");
    expect(call?.t.request(call.input as never, "agent:x")).toMatchObject({ op: "read", path: "a.md", at: Date.parse("2026-11-02T14:05+08:00") });
  });

  it("names the forms it takes when given something else", async () => {
    const { call, stderr } = await run("read", "--path", "a.md", "--at", "yesterday");
    expect(call).toBeUndefined();
    expect(stderr).toContain("30m, 2h, 1d, 1w or an ISO 8601 time");
  });
});

describe("ob-provenance help", () => {
  it("opens with the commands and ends with how to work in a vault", async () => {
    const { stdout, error } = await run("--help");
    expect(error?.exitCode).toBe(0);
    for (const t of TOOLS) expect(stdout).toContain(`  ${t.command}`);
    expect(stdout).toContain(instructions("cli"));
  });

  it("shows each command's fields and examples, by --help or help", async () => {
    for (const t of TOOLS) {
      const { stdout } = await run(t.command, "--help");
      for (const key of Object.keys(t.cli?.input ?? t.input)) expect(stdout).toContain(`--${key}`);
      for (const example of t.examples) expect(stdout).toContain(example);
      expect((await run("help", t.command)).stdout).toBe(stdout);
    }
  });

  it("gives every command an example that parses", async () => {
    for (const t of TOOLS) {
      expect(t.examples.length).toBeGreaterThan(0);
      for (const example of t.examples) {
        const [bin, ...argv] = words(example);
        expect(bin).toBe("ob-provenance");
        expect((await run(...argv)).call?.t.command, example).toBe(t.command);
      }
    }
  });
});
