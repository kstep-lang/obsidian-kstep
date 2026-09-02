import { App, PluginSettingTab, Setting } from "obsidian";
import type KStepPlugin from "../main";

// Debounce delay for the CLI-path field's onChange → saveSettings(). Every
// saveSettings() call clears the whole render cache and writes data.json to
// disk (see main.ts), so calling it on every keystroke of a ~60-character
// path both invalidates cached renders dozens of times over and, if a note
// happens to re-render mid-edit, briefly runs the CLI against a truncated,
// not-yet-finished path. 400ms of typing silence is long enough to not feel
// laggy while collapsing a whole typed path into a single save.
const SETTINGS_SAVE_DEBOUNCE_MS = 400;

export class KStepSettingsTab extends PluginSettingTab {
  plugin: KStepPlugin;
  private saveTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(app: App, plugin: KStepPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    // Flush a pending debounced save immediately rather than lose it if the
    // user closes the settings tab within the debounce window.
    if (this.saveTimeout !== undefined) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = undefined;
      void this.plugin.saveSettings();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimeout !== undefined) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = undefined;
      void this.plugin.saveSettings();
    }, SETTINGS_SAVE_DEBOUNCE_MS);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // No top heading with the plugin name: Obsidian shows it in the tab
    // header automatically, and the community-plugin reviewer rejects a
    // heading that duplicates it (documented finding from obsidian-kuml's
    // KumlSettingsTab.ts).
    containerEl.createEl("p", {
      cls: "kstep-settings-warning",
      text:
        "A kstep code block is a Kotlin script that is executed on this computer " +
        "when the note is rendered. Only use notes from sources you trust.",
    });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Renders kstep code blocks as an inline geometry preview (when the model has " +
        "geometry) or a formatted product-structure card (when it does not). " +
        "Diagrams are evaluated by the kstep-cli binary.",
    });

    new Setting(containerEl)
      .setName("CLI path")
      .setDesc(
        "Path to the kstep-cli binary. Use 'kstep-cli' in a Gradle installDist build " +
          "(e.g. …/kSTEP/kstep-cli/build/install/kstep-cli/bin/kstep-cli), or 'kstep' if " +
          "installed via a package manager. Desktop only.",
      )
      .addText((text) =>
        text
          .setPlaceholder("kstep-cli")
          .setValue(this.plugin.settings.cliPath)
          .onChange((value) => {
            this.plugin.settings.cliPath = value.trim();
            this.scheduleSave();
          }),
      );
  }
}
