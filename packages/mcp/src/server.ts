import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { slug, type AgentId } from "@provenance/core";
import { instructions, runTool, toolsFor, type Mode, type OpsTransport } from "@provenance/tools";
import pkg from "../package.json" with { type: "json" };

/** The identity an MCP client announces in its handshake, e.g. "Claude Code" becomes agent:claude-code. */
export function agentFromClientName(client: string | undefined): AgentId | null {
  const name = slug(client ?? "");
  return name ? `agent:${name}` : null;
}

/**
 * Exposes vault ops as MCP tools. Limited mode is the subset a server can
 * serve without Obsidian; full mode adds the tools that need Obsidian's
 * metadata cache and file operations.
 *
 * Edits are attributed to `agent` when it is pinned, otherwise to the name
 * the client gave in the MCP handshake, so several agents can share one
 * server configuration and still be told apart.
 */
export function createMcpServer(opts: { ops: OpsTransport; agent: AgentId | null; mode: Mode }): McpServer {
  const server = new McpServer({ name: "obsidian-provenance", version: pkg.version }, { instructions: instructions(opts.mode) });
  const identity = () => opts.agent ?? agentFromClientName(server.server.getClientVersion()?.name);
  for (const t of toolsFor(opts.mode)) {
    const { description, input: inputSchema, annotations } = t;
    server.registerTool(t.mcpName, { description, inputSchema, ...(annotations ? { annotations } : {}) }, async (args: unknown): Promise<CallToolResult> => {
      const { text, isError } = await runTool(t, args, { ops: opts.ops, agent: identity(), noAgent: "this MCP client sent no name; start the server with agent=<name>" });
      return { ...(isError ? { isError } : {}), content: [{ type: "text", text }] };
    });
  }
  return server;
}
