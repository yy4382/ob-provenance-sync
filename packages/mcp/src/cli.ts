#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentIdSchema } from "@provenance/core";
import { createMcpServer } from "./server";
import { httpOps, localOps } from "./transport";

const usage = `provenance-mcp --vault-path <dir> --agent <name> [--server <url> --vault <id> --token <token>]

Local MCP server for an Obsidian vault. Edits go through the running
Obsidian plugin; when Obsidian is closed they go to the sync server.
The token can also come from PROVENANCE_TOKEN.`;

const { values } = parseArgs({
  options: {
    "vault-path": { type: "string" },
    agent: { type: "string" },
    server: { type: "string" },
    vault: { type: "string" },
    token: { type: "string" },
    help: { type: "boolean" },
  },
});

const vaultPath = values["vault-path"];
const agent = agentIdSchema.safeParse(values.agent?.includes(":") ? values.agent : `agent:${values.agent}`);
const token = values.token ?? process.env.PROVENANCE_TOKEN;
if (values.help || !vaultPath || !values.agent || !agent.success) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}
if (values.server && !(values.vault && token)) {
  console.error("--server needs --vault and a token\n\n" + usage);
  process.exit(2);
}

const remote = values.server
  ? httpOps(`${values.server.replace(/\/$/, "")}/api/vaults/${encodeURIComponent(values.vault!)}/ops`, token!)
  : null;
const server = createMcpServer({ ops: localOps({ vaultPath, remote }), agent: agent.data, mode: "full" });
await server.connect(new StdioServerTransport());
