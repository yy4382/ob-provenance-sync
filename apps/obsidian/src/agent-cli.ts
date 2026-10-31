import packed from "virtual:agent-cli";
import { agentPaths, isNewerVersion, type VaultEntry } from "@provenance/core";
import { FileSystemAdapter, Platform, type App } from "obsidian";
import { deviceVaultId } from "./quirks";

async function unpack(): Promise<string> {
  const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/** Desktop only: Node's modules are loaded lazily so the plugin still loads on mobile. */
function desktop() {
  if (!Platform.isDesktop) throw new Error("the agent CLI needs the desktop app");
  /* eslint-disable @typescript-eslint/no-require-imports, no-undef -- Obsidian provides require and process on desktop */
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const paths = agentPaths(os.homedir(), process.env.XDG_CONFIG_HOME);
  /* eslint-enable @typescript-eslint/no-require-imports, no-undef -- the rest is plain code */

  /** Other processes read these files, so they only ever see a whole one. */
  const replace = async (file: string, text: string, mode: number) => {
    const tmp = `${file}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, text, { mode });
    await fs.rename(tmp, file);
  };
  return { fs, path, paths, replace };
}

const versionOf = (cli: string) => /^\/\/ ob-provenance (\S+)$/m.exec(cli)?.[1] ?? "0";

/** Writes the bundled CLI to ~/.local/bin and returns its path. Every vault shares this file, so one on an older plugin must not undo a newer one. */
export async function installCli(): Promise<string> {
  const { fs, path, paths, replace } = desktop();
  const cli = await unpack();
  const installed = await fs.readFile(paths.bin, "utf8").catch(() => null);
  if (installed === cli || (installed && isNewerVersion(versionOf(installed), versionOf(cli)))) return paths.bin;
  await fs.mkdir(path.dirname(paths.bin), { recursive: true });
  await replace(paths.bin, cli, 0o755);
  return paths.bin;
}

const entryFile = (app: App, vaults: string) => `${vaults}/${deviceVaultId(app)}.json`;

/** Tells the CLI about this vault. The entry holds the device token, so only this user can read it. */
export async function registerVault(app: App, server: VaultEntry["server"]) {
  const { fs, paths, replace } = desktop();
  const entry: VaultEntry = { name: app.vault.getName(), path: (app.vault.adapter as FileSystemAdapter).getBasePath(), server };
  await fs.mkdir(paths.vaults, { recursive: true, mode: 0o700 });
  await replace(entryFile(app, paths.vaults), JSON.stringify(entry), 0o600);
}

export async function unregisterVault(app: App) {
  const { fs, paths } = desktop();
  await fs.rm(entryFile(app, paths.vaults), { force: true });
}

export interface LocalMcpCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The vault is pinned by id, so an agent's writes can't drift to another vault with its working directory. */
export function localMcpCommand(app: App, cliPath: string): LocalMcpCommand {
  return { command: "node", args: [cliPath, `vault=${deviceVaultId(app)}`, "mcp"], env: {} };
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** A ready-to-paste `claude mcp add` command. */
export function claudeCodeCommand(cmd: LocalMcpCommand): string {
  return ["claude", "mcp", "add", "--scope", "user", "obsidian", "--", cmd.command, ...cmd.args].map(quote).join(" ");
}

/** The same server as a JSON entry for MCP clients configured by file. */
export function mcpJsonConfig(cmd: LocalMcpCommand): string {
  return JSON.stringify({ mcpServers: { obsidian: cmd } }, null, 2);
}
