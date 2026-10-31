import { styleText } from "node:util";
import { instructions, recordsAuthor, TOOLS, type ToolDef } from "@provenance/tools";
import { Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";

export interface Target {
  vault?: string;
  agent?: string;
}

export interface Actions {
  stdin(): Promise<string>;
  tool(t: ToolDef, input: unknown, target: Target): Promise<void>;
  vaults(): Promise<void>;
  status(target: Target): Promise<void>;
  mcp(target: Target): Promise<void>;
}

/** An empty value is usually a shell variable that was never set, so it must not read as "not given". */
function named(value: string): string {
  if (!value) throw new InvalidArgumentError("It is empty.");
  return value;
}

const vaultOption = new Option("--vault <name>", "Vault name or id. Without it: the vault folder you're in, then OB_PROVENANCE_VAULT, then your only vault.").argParser(named);
const agentOption = () => new Option("--agent <name>", "Your name, e.g. claude-code. Every write needs it. Or set OB_PROVENANCE_AGENT.").argParser(named);

function fieldOption(key: string, field: z.ZodType): Option {
  const required = field.safeParse(undefined).success ? [] : ["(required)"];
  return new Option(field.safeParse(true).success ? `--${key}` : `--${key} <value>`, [field.description ?? "", ...required].join(" ").trim());
}

function addTool(program: Command, t: ToolDef, actions: Actions) {
  const fields = Object.entries(t.input as Record<string, z.ZodType>);
  const cmd = program
    .command(t.command)
    .summary(t.description.split(". ")[0]!.replace(/\.$/, ""))
    .description(t.description)
    .showHelpAfterError(`See: ob-provenance ${t.command} --help`)
    .addHelpText("after", `\nExamples:\n${t.examples.map((e) => `  ${e}`).join("\n")}`);
  for (const [key, field] of fields) cmd.addOption(fieldOption(key, field));
  if (recordsAuthor(t)) {
    const text = fields.filter(([key, field]) => key !== "path" && field.safeParse("").success).map(([key]) => key);
    cmd.addOption(new Option("--stdin <field>", "Read this field from stdin, for text with quotes or line breaks.").choices(text));
  }
  cmd.addOption(vaultOption).addOption(agentOption().hideHelp(!recordsAuthor(t)));
  cmd.action(async () => {
    const opts = cmd.optsWithGlobals<Target & { stdin?: string }>();
    const given = opts.stdin ? { ...opts, [opts.stdin]: await actions.stdin() } : opts;
    // Required fields are checked here, not by Commander, because --stdin can supply them.
    const input = z.object(t.input).safeParse(given);
    if (!input.success) cmd.error(z.prettifyError(input.error));
    await actions.tool(t, input.data, opts);
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
    .description("Show whether a call would reach Obsidian or the sync server")
    .addOption(vaultOption)
    .action((_opts, cmd: Command) => actions.status(cmd.optsWithGlobals<Target>()));
  program
    .command("mcp")
    .description("Serve these commands as an MCP server on stdio")
    .addOption(vaultOption)
    .addOption(agentOption())
    .action((_opts, cmd: Command) => actions.mcp(cmd.optsWithGlobals<Target>()));
  return program;
}
