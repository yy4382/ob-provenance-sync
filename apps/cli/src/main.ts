#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAgentName, type AgentId } from "@provenance/core";
import { createMcpServer } from "@provenance/mcp";
import { instructions, runTool, TOOLS, type ToolDef } from "@provenance/tools";
import { z } from "zod";
import { parseArgv, UsageError, type Invocation } from "./args";
import { readVaults } from "./config";
import { agentOps, describeRoute } from "./route";
import { selectVault, type Selection } from "./vault";

const USAGE = `ob-provenance [vault=<name>] <command> [key=value ...] [--stdin=<field>]

Commands
${TOOLS.map((t) => `  ${t.command.padEnd(16)}${t.description.split(". ")[0]!.replace(/\.$/, "")}`).join("\n")}
  vaults          List the vaults you can use
  status          Show whether a call would reach Obsidian or the sync server
  mcp             Serve these commands as an MCP server on stdio
  help <command>  Show a command's fields`;

function commandHelp(t: ToolDef): string {
  const fields = Object.entries(t.input as Record<string, z.ZodType>).map(([key, field]) => {
    const value = field.safeParse(true).success ? key : `${key}=<value>`;
    return `  ${value}${field.safeParse(undefined).success ? "" : " (required)"}${field.description ? `\n      ${field.description}` : ""}`;
  });
  return [`ob-provenance ${t.command}`, "", t.description, ...(fields.length ? ["", ...fields] : [])].join("\n");
}

/** Arguments arrive as strings; a boolean field takes a bare key or true/false. */
function toInput(t: ToolDef, args: Invocation["args"]): unknown {
  const input = t.input as Record<string, z.ZodType>;
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const field = input[key];
    if (!field) throw new UsageError(`${t.command} has no field ${key}. See: ob-provenance help ${t.command}`);
    parsed[key] = (value === "true" || value === "false") && field.safeParse(value === "true").success && !field.safeParse(value).success ? value === "true" : value;
  }
  const result = z.object(input).safeParse(parsed);
  if (!result.success) throw new UsageError(`${z.prettifyError(result.error)}\nSee: ob-provenance help ${t.command}`);
  return result.data;
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

function pinnedAgent(args: Invocation["args"]): AgentId | null {
  const name = args.agent ?? process.env.OB_PROVENANCE_AGENT;
  delete args.agent;
  if (!name) return null;
  const agent = typeof name === "string" ? parseAgentName(name) : null;
  if (!agent) throw new UsageError(`invalid agent name: ${String(name)}`);
  return agent;
}

const select = (vault: string | null) => async (): Promise<Selection> =>
  selectVault(await readVaults(), { arg: vault, env: process.env.OB_PROVENANCE_VAULT, cwd: process.cwd() });

const print = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

async function selected(vault: string | null) {
  const selection = await select(vault)();
  if (!selection.ok) throw new UsageError(selection.message);
  return selection.vault;
}

async function main(argv: string[]) {
  const inv = parseArgv(argv);
  const { command, args } = inv;
  if (command === null || command === "help" || command === "--help") {
    const t = TOOLS.find((t) => args[t.command] === true);
    return print(t ? commandHelp(t) : `${USAGE}\n\n${instructions("cli")}`);
  }
  if (command === "vaults") {
    const vaults = await readVaults();
    return print(vaults.map((v) => `${v.name}\t${v.path}\t${v.server ? v.server.url : "no sync server"}`).join("\n") || "(no vaults have Agent CLI turned on)");
  }
  if (command === "status") return print((await describeRoute(await selected(inv.vault))).join("\n"));
  const agent = pinnedAgent(args);
  if (command === "mcp") return createMcpServer({ ops: agentOps({ select: select(inv.vault) }), agent, mode: "full" }).connect(new StdioServerTransport());

  const t = TOOLS.find((t) => t.command === command);
  if (!t) throw new UsageError(`unknown command ${command}. See: ob-provenance help`);
  if (inv.stdinField) args[inv.stdinField] = await readStdin();
  const input = toInput(t, args);
  const vault = await selected(inv.vault);
  const noAgent = "name yourself with agent=<name> or OB_PROVENANCE_AGENT, e.g. agent=claude-code";
  const { text, isError } = await runTool(t, input, { ops: agentOps({ select: async () => ({ ok: true, vault }) }), agent, noAgent });
  if (!isError) return print(text);
  process.stderr.write(`${text}\n`);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = e instanceof UsageError ? 2 : 1;
});
