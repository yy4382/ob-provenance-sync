import { instructions, TOOLS, type ToolDef } from "@provenance/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram, type Target } from "../src/program";

afterEach(() => void vi.restoreAllMocks());

async function run(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((stderr += String(s)), true));
  const calls: { t: ToolDef; input: unknown; target: Target }[] = [];
  const program = buildProgram({
    stdin: async () => "from stdin\n",
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
const words = (example: string) => example.split(" < ")[0]!.match(/"[^"]*"|\S+/g)!.map((w) => w.replace(/^"|"$/g, ""));

describe("ob-provenance arguments", () => {
  it("takes --vault and --agent before or after the command", async () => {
    expect((await run("--vault", "Notes", "--agent", "a", "list")).call?.target).toMatchObject({ vault: "Notes", agent: "a" });
    expect((await run("list", "--vault", "Notes", "--agent", "a")).call?.target).toMatchObject({ vault: "Notes", agent: "a" });
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
      for (const key of Object.keys(t.input)) expect(stdout).toContain(`--${key}`);
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
