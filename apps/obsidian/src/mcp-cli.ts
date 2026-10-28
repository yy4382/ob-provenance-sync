import packed from "virtual:mcp-cli";
import { FileSystemAdapter, type App } from "obsidian";

export const MCP_CLI_FILE = "provenance-mcp.mjs";

async function unpack(): Promise<string> {
  const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/** Writes the bundled MCP server into the plugin folder (desktop only) and returns its absolute path. */
export async function installMcpCli(app: App, pluginDir: string): Promise<string | null> {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) return null;
  const path = `${pluginDir}/${MCP_CLI_FILE}`;
  const cli = await unpack();
  if (!(await adapter.exists(path)) || (await adapter.read(path)) !== cli) await adapter.write(path, cli);
  return adapter.getFullPath(path);
}

export interface LocalMcpCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function localMcpCommand(app: App, cliPath: string, server: { url: string; vault: string; token: string } | null): LocalMcpCommand {
  const vaultPath = (app.vault.adapter as FileSystemAdapter).getBasePath();
  const args = [cliPath, "--vault-path", vaultPath];
  if (server) args.push("--server", server.url, "--vault", server.vault);
  return { command: "node", args, env: server ? { PROVENANCE_TOKEN: server.token } : {} };
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** A ready-to-paste `claude mcp add` command. */
export function claudeCodeCommand(cmd: LocalMcpCommand): string {
  const env = Object.entries(cmd.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["claude", "mcp", "add", "--scope", "user", ...env, "obsidian", "--", cmd.command, ...cmd.args].map(quote).join(" ");
}

/** The same server as a JSON entry for MCP clients configured by file. */
export function mcpJsonConfig(cmd: LocalMcpCommand): string {
  return JSON.stringify({ mcpServers: { obsidian: cmd } }, null, 2);
}
