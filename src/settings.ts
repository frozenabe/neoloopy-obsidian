import { App, PluginSettingTab, Setting } from "obsidian";
import type NeoloopyPlugin from "./main";

export interface NeoloopySettings {
  /** Flash externally-changed nodes/edges with a "live edit" spotlight. */
  liveEditSpotlight: boolean;
  /** Folder under which new models are created. */
  defaultModelFolder: string;
  /** Whether the right-docked insight panel is open. */
  insightPanelOpen: boolean;
}

export const DEFAULT_SETTINGS: NeoloopySettings = {
  liveEditSpotlight: true,
  defaultModelFolder: "neoloopy",
  insightPanelOpen: true,
};

export class NeoloopySettingTab extends PluginSettingTab {
  plugin: NeoloopyPlugin;

  constructor(app: App, plugin: NeoloopyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Canvas").setHeading();

    new Setting(containerEl)
      .setName("Default model folder")
      .setDesc("New models are created as subfolders here.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.defaultModelFolder)
          .onChange(async (v) => {
            this.plugin.settings.defaultModelFolder = v.trim() || "neoloopy";
            await this.plugin.saveSettings();
            this.plugin.rebuildEngine(); // new models honour the folder immediately
          }),
      );

    new Setting(containerEl)
      .setName("Live-edit spotlight")
      .setDesc("Flash nodes/edges that change outside the canvas (e.g. edited in a note or by an agent).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.liveEditSpotlight).onChange(async (v) => {
          this.plugin.settings.liveEditSpotlight = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
