import { Platform, PluginSettingTab, Setting, type App } from "obsidian";
import type ProvenancePlugin from "./main";

export interface ProvenanceSettings {
  /** https://host[:port] of the sync server; empty keeps provenance on this device only. */
  serverUrl: string;
  token: string;
  vaultId: string;
  humanName: string;
  deviceName: string;
  showColors: boolean;
  enableBridge: boolean;
}

export function defaultSettings(app: App): ProvenanceSettings {
  const slug = (s: string) => s.toLowerCase().replace(/[^\w.@-]+/g, "-").replace(/^-|-$/g, "") || "vault";
  const suffix = Math.random().toString(36).slice(2, 6);
  return {
    serverUrl: "",
    token: "",
    vaultId: slug(app.vault.getName()),
    humanName: "me",
    deviceName: `${Platform.isMobile ? "mobile" : "desktop"}-${suffix}`,
    showColors: true,
    enableBridge: true,
  };
}

export class ProvenanceSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ProvenancePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    const text = (name: string, desc: string, key: "serverUrl" | "token" | "vaultId" | "humanName" | "deviceName", secret = false) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          if (secret) t.inputEl.type = "password";
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = v.trim();
            await this.plugin.saveSettings();
          });
        });

    new Setting(containerEl).setName("Identity").setHeading();
    text("Your name", "Text you type is attributed to human:<name>.", "humanName");
    text("Device name", "Recorded with every change made on this device.", "deviceName");

    new Setting(containerEl).setName("Sync").setHeading();
    text("Server URL", "For example https://sync.example.com. Leave empty to track provenance on this device only.", "serverUrl");
    text("Device token", "A device token from the server's config.", "token", true);
    text("Vault ID", "Must be the same on every device that syncs this vault.", "vaultId");
    new Setting(containerEl)
      .setName("Apply")
      .setDesc("Restart syncing with the settings above.")
      .addButton((b) => b.setButtonText("Reconnect").onClick(() => void this.plugin.restartSync()));

    new Setting(containerEl).setName("Display").setHeading();
    new Setting(containerEl)
      .setName("Color text by author")
      .setDesc("Background colors for text by you, by agents, dictated through agents, or mixed.")
      .addToggle((t) =>
        t.setValue(s.showColors).onChange(async (v) => {
          s.showColors = v;
          await this.plugin.saveSettings();
          this.plugin.applyColors();
        }),
      );

    if (Platform.isDesktopApp) {
      new Setting(containerEl).setName("Agents").setHeading();
      new Setting(containerEl)
        .setName("Local agent bridge")
        .setDesc("Let local agents edit this vault through provenance-mcp while Obsidian is running.")
        .addToggle((t) =>
          t.setValue(s.enableBridge).onChange(async (v) => {
            s.enableBridge = v;
            await this.plugin.saveSettings();
            await this.plugin.restartSync();
          }),
        );
    }
  }
}
