import { styleText } from "node:util";
import { instructions, recordsAuthor, TOOLS, type ToolDef } from "@provenance/tools";
import { Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";

export interface Target {
  vault?: string;
  agent?: string;
  json?: boolean;
}

export interface Actions {
  stdin(): Promise<string>;
  tool(t: ToolDef, input: unknown, target: Target): Promise<void>;
  vaults(): Promise<void>;
  status(target: Target): Promise<void>;
  mcp(target: Target): Promise<void>;
}

/** An empty value is usually a shell variable that was never set, so it must not read as "not given". */
function named(value: string, previous?: string): string {
  if (!value) throw new InvalidArgumentError("It is empty.");
  if (previous && previous !== value) throw new InvalidArgumentError(`It was already given as ${previous}.`);
  return value;
}

const vaultOption = new Option("--vault <name>", "Vault name or id. Every call needs it. Or set OB_PROVENANCE_VAULT.").argParser(named);
const agentOption = () => new Option("--agent <name>", "Your name, e.g. claude-code. Every write needs it. Or set OB_PROVENANCE_AGENT.").argParser(named);

function fieldOption(key: string, field: z.ZodType): Option {
  const required = field.safeParse(undefined).success ? [] : ["(required)"];
  // Commander camel-cases a dashed flag back, so the value still lands on `key`.
  const flag = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  return new Option(field.safeParse(true).success ? flag : `${flag} <value>`, [field.description ?? "", ...required].join(" ").trim());
}

/** These flags work on either side of the command, and Commander would quietly keep the outer one. */
function targetOf<T extends Target>(cmd: Command): T {
  const outer = cmd.parent!.opts<Target>();
  const inner = cmd.opts<Target>();
  for (const key of ["vault", "agent"] as const) {
    if (outer[key] && inner[key] && outer[key] !== inner[key]) cmd.error(`--${key} was given twice, as ${outer[key]} and ${inner[key]}.`);
  }
  return cmd.optsWithGlobals<T>();
}

/** The end of a heredoc or file isn't part of an edit's string: kept, it would split the line the string lands in. */
const trimsStdin = (t: ToolDef) => t.op === "edit";

async function fromStdin(cmd: Command, opts: object, field: string, t: ToolDef, actions: Actions): Promise<string> {
  if (field in opts) cmd.error(`--stdin ${field} and --${field} both give ${field}. Use one.`);
  const piped = await actions.stdin();
  const text = trimsStdin(t) ? piped.replace(/\r?\n$/, "") : piped;
  // In an edit this would delete the match, and a failed pipe shouldn't be able to do that.
  if (!text) cmd.error(`--stdin ${field} read nothing. For an empty value, pass --${field} "".`);
  return text;
}

function stdinOption(fields: string[], trims: boolean): Option {
  const option = new Option("--stdin <field>", `Read this field from stdin, for text with quotes or line breaks.${trims ? " One line break at its end is dropped." : ""}`).choices(fields);
  const choose = option.parseArg!;
  return option.argParser((field: string, previous: string) => {
    if (previous) throw new InvalidArgumentError(`Only one field can come from stdin. Pass the other with its flag, e.g. --${previous} "$(cat file)".`);
    return choose(field, previous);
  });
}

function addTool(program: Command, t: ToolDef, actions: Actions) {
  const shape = t.cli?.input ?? t.input;
  const fields = Object.entries(shape as Record<string, z.ZodType>);
  const cmd = program
    .command(t.command)
    .summary(t.description.split(". ")[0]!.replace(/\.$/, ""))
    .description(t.description)
    .showHelpAfterError(`See: ob-provenance ${t.command} --help`)
    .addHelpText("after", `\nExamples:\n${t.examples.map((e) => `  ${e}`).join("\n")}`);
  for (const [key, field] of fields) cmd.addOption(fieldOption(key, field));
  if (recordsAuthor(t)) {
    cmd.addOption(stdinOption(fields.filter(([key, field]) => key !== "path" && field.safeParse("").success).map(([key]) => key), trimsStdin(t)));
  }
  if (t.output) cmd.addOption(new Option("--json", "Print the result as JSON."));
  cmd.addOption(vaultOption).addOption(agentOption().hideHelp(!recordsAuthor(t)));
  cmd.action(async () => {
    const opts = targetOf<Target & { stdin?: string }>(cmd);
    const given = opts.stdin ? { ...opts, [opts.stdin]: await fromStdin(cmd, opts, opts.stdin, t, actions) } : opts;
    // Required fields are checked here, not by Commander, because --stdin can supply them.
    const input = z.object(shape).safeParse(given);
    if (!input.success) cmd.error(z.prettifyError(input.error));
    await actions.tool(t, t.cli ? t.cli.toInput(input.data as never) : input.data, opts);
  });
}

export function buildProgram(actions: Actions): Command {
  const program = new Command("ob-provenance")
    .usage("[--vault <name>] <command> [--<field> <value> ...]")
    .description("Read and write the human's Obsidian vault, recording who wrote every character.")
    // Otherwise the top level scans every argument, and text that is literally --vault is taken as the option.
    .enablePositionalOptions()
    .exitOverride()
    .configureHelp({ styleTitle: (title) => styleText("bold", title), subcommandTerm: (cmd) => cmd.name() })
    .helpOption("-h, --help", "Show help")
    .showHelpAfterError("See: ob-provenance --help")
    .addOption(vaultOption)
    .addOption(agentOption())
    .addHelpText("after", `\n${instructions("cli")}`);

  program.commandsGroup("Notes:");
  for (const t of TOOLS) addTool(program, t, actions);

  program.commandsGroup("Setup:").helpCommand("help [command]", "Show a command's fields and examples");
  program
    .command("vaults")
    .description("List the vaults you can use")
    .action(() => actions.vaults());
  program
    .command("status")
    .description("Show whether a call would reach Obsidian or the sync server. Like any call, it opens the vault in Obsidian if it's closed")
    .addOption(vaultOption)
    .action((_opts, cmd: Command) => actions.status(targetOf(cmd)));
  program
    .command("mcp")
    .description("Serve these commands as an MCP server on stdio")
    .addOption(vaultOption)
    .addOption(agentOption())
    .action((_opts, cmd: Command) => actions.mcp(targetOf(cmd)));
  return program;
}
