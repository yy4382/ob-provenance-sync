#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAgentName, type AgentId } from "@provenance/core";
import { createMcpServer } from "@provenance/mcp";
import { runTool } from "@provenance/tools";
import { CommanderError } from "commander";
import { readVaults } from "./config";
import { buildProgram, type Target } from "./program";
import { agentOps, describeRoute } from "./route";
import { selectVault, type Selection } from "./vault";

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

/** For a call that parsed but can't go ahead: the message says what to do, so it needs no pointer to help. */
const refuse = (message: string) => program.showHelpAfterError(false).error(message);

function pinnedAgent(target: Target): AgentId | null {
  const name = target.agent ?? process.env.OB_PROVENANCE_AGENT;
  if (!name) return null;
  return parseAgentName(name) ?? refuse(`invalid agent name: ${name}`);
}

const select = (target: Target) => async (): Promise<Selection> =>
  selectVault(await readVaults(), { arg: target.vault ?? null, env: process.env.OB_PROVENANCE_VAULT, cwd: process.cwd() });

const print = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

async function selected(target: Target) {
  const selection = await select(target)();
  return selection.ok ? selection.vault : refuse(selection.message);
}

const program = buildProgram({
  stdin: readStdin,
  async vaults() {
    const vaults = await readVaults();
    print(vaults.map((v) => `${v.name}\t${v.path}\t${v.server ? v.server.url : "no sync server"}`).join("\n") || "(no vaults have Agent CLI turned on)");
  },
  async status(target) {
    print((await describeRoute(await selected(target))).join("\n"));
  },
  mcp: (target) => createMcpServer({ ops: agentOps({ select: select(target) }), agent: pinnedAgent(target), mode: "full" }).connect(new StdioServerTransport()),
  async tool(t, input, target) {
    const agent = pinnedAgent(target);
    const vault = await selected(target);
    const noAgent = "name yourself with --agent <name> or OB_PROVENANCE_AGENT, e.g. --agent claude-code";
    const { text, isError } = await runTool(t, input, { ops: agentOps({ select: async () => ({ ok: true, vault }) }), agent, noAgent });
    if (!isError) return void print(text);
    process.stderr.write(`${text}\n`);
    process.exitCode = 1;
  },
});

const argv = process.argv.slice(2);
program.parseAsync(argv.length ? argv : ["--help"], { from: "user" }).catch((e: unknown) => {
  if (e instanceof CommanderError) {
    process.exitCode = e.exitCode && 2;
    return;
  }
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
