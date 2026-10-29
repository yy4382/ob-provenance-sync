import { slug } from "@provenance/core";
import { Notice, Platform, PluginSettingTab, type App, type SettingDefinitionItem } from "obsidian";
import { claudeCodeCommand, mcpJsonConfig, type LocalMcpCommand } from "./mcp-cli";
import type ProvenancePlugin from "./main";

export interface ProvenanceSettings {
  /** https://host[:port] of the sync server; empty keeps provenance on this device only. */
  serverUrl: string;
  /** Id of the device token in Obsidian's keychain, not the token itself. */
  tokenSecret: string;
  vaultId: string;
  humanName: string;
  deviceName: string;
  showColors: boolean;
  enableBridge: boolean;
  /** Last agent named when marking text as an agent's, offered again next time. */
  lastAgentName: string;
}

export function defaultSettings(app: App): ProvenanceSettings {
  const suffix = Math.random().toString(36).slice(2, 6);
  return {
    serverUrl: "",
    tokenSecret: "",
    vaultId: slug(app.vault.getName()) || "vault",
    humanName: "me",
    deviceName: `${Platform.isMobile ? "mobile" : "desktop"}-${suffix}`,
    showColors: true,
    enableBridge: true,
    lastAgentName: "chatgpt",
  };
}

/** Changing these needs a fresh connection; the Reconnect action applies them. */
const RESTART_KEYS = new Set<keyof ProvenanceSettings>(["enableBridge"]);

export class ProvenanceSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ProvenancePlugin,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem<keyof ProvenanceSettings>[] {
    return [
      {
        type: "group",
        heading: "Identity",
        items: [
          { name: "Your name", desc: "Text you type is attributed to human:<name>.", control: { type: "text", key: "humanName" } },
          { name: "Device name", desc: "Recorded with every change made on this device.", control: { type: "text", key: "deviceName" } },
        ],
      },
      {
        type: "group",
        heading: "Sync",
        items: [
          {
            name: "Server URL",
            desc: "For example https://sync.example.com. Leave empty to track provenance on this device only.",
            control: { type: "text", key: "serverUrl", placeholder: "https://sync.example.com" },
          },
          {
            name: "Device token",
            desc: "A device token from the server's config, kept in Obsidian's keychain.",
            control: { type: "secret", key: "tokenSecret" },
          },
          { name: "Vault ID", desc: "Must be the same on every device that syncs this vault.", control: { type: "text", key: "vaultId" } },
          {
            name: "Reconnect",
            desc: "Stops syncing, writes pending changes to disk, and starts again with the settings above. It doesn't change your notes. The sync event log shows what happened.",
            action: () => void this.plugin.reconnect(),
          },
        ],
      },
      {
        type: "group",
        heading: "Display",
        items: [
          {
            name: "Color text by author",
            desc: "Background colors for text by you, by agents, dictated through agents, or mixed.",
            control: { type: "toggle", key: "showColors" },
          },
        ],
      },
      {
        type: "group",
        heading: "Agents",
        items: [
          {
            name: "Local agent bridge",
            desc: "Let local agents edit this vault through provenance-mcp while Obsidian is running.",
            visible: Platform.isDesktopApp,
            control: { type: "toggle", key: "enableBridge" },
          },
          {
            name: "Copy Claude Code command",
            desc: "Adds this vault's MCP server to Claude Code. Needs Node.js 22 or later. Agents are named after the MCP client they use.",
            visible: Platform.isDesktopApp,
            action: () => this.copy((cmd) => claudeCodeCommand(cmd)),
          },
          {
            name: "Copy MCP JSON config",
            desc: "The same server as an mcpServers entry, for clients configured by file.",
            visible: Platform.isDesktopApp,
            action: () => this.copy((cmd) => mcpJsonConfig(cmd)),
          },
        ],
      },
    ];
  }

  private copy(format: (cmd: LocalMcpCommand) => string) {
    const cmd = this.plugin.mcpCommand();
    if (!cmd) return void new Notice("Still preparing the agent server; try again in a moment.");
    void navigator.clipboard.writeText(format(cmd)).then(() => new Notice("Copied. It contains your device token, so keep it private."));
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    await super.setControlValue(key, typeof value === "string" ? value.trim() : value);
    if (key === "showColors") this.plugin.applyColors();
    if (RESTART_KEYS.has(key as keyof ProvenanceSettings)) await this.plugin.restartSync();
  }
}
