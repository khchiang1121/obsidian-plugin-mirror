import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type MirrorInstallerPlugin from './main';
import { fetchIndex, fetchVersions, type RegistryEntry } from './registry';
import { sortVersionsNewestFirst, selectUpdateCandidate } from './versionCompare';
import { installPluginVersion, removePlugin, type VaultAdapterLike, type PluginManagerLike } from './installer';

export class MirrorInstallerSettingTab extends PluginSettingTab {
  plugin: MirrorInstallerPlugin;

  constructor(app: App, plugin: MirrorInstallerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private getAdapter(): VaultAdapterLike {
    return this.app.vault.adapter as unknown as VaultAdapterLike;
  }

  private getPluginManager(): PluginManagerLike {
    return (this.app as unknown as { plugins: PluginManagerLike }).plugins;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Mirror base URL')
      .setDesc('Internal nginx server hosting the plugin mirror.')
      .addText((text) =>
        text.setValue(this.plugin.settings.mirrorBaseUrl).onChange(async (value) => {
          this.plugin.settings.mirrorBaseUrl = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Check for updates on startup')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoCheckOnStartup).onChange(async (value) => {
          this.plugin.settings.autoCheckOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Install updates automatically')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoInstallUpdates).onChange(async (value) => {
          this.plugin.settings.autoInstallUpdates = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Check for updates now')
      .addButton((button) =>
        button.setButtonText('Check now').onClick(async () => {
          await this.plugin.runUpdateCheck();
          this.display();
        })
      );

    containerEl.createEl('h3', { text: 'Installed mirrored plugins' });
    this.renderInstalledPlugins(containerEl);

    containerEl.createEl('h3', { text: 'Available in mirror' });
    void this.renderRegistry(containerEl);
  }

  private renderInstalledPlugins(containerEl: HTMLElement): void {
    const tracked = this.plugin.settings.trackedPlugins;
    const ids = Object.keys(tracked);
    if (ids.length === 0) {
      containerEl.createEl('p', { text: 'No mirrored plugins installed yet.' });
      return;
    }

    for (const id of ids) {
      const entry = tracked[id];
      const pending = this.plugin.pendingUpdates.get(id);
      const setting = new Setting(containerEl)
        .setName(id)
        .setDesc(
          pending?.candidate
            ? `Installed v${entry.installedVersion} — update available: v${pending.candidate.version}`
            : `Installed v${entry.installedVersion}`
        );

      if (pending?.candidate) {
        const candidate = pending.candidate;
        setting.addButton((button) =>
          button.setButtonText('Install update').onClick(async () => {
            try {
              await installPluginVersion(
                this.getAdapter(),
                this.getPluginManager(),
                this.plugin.settings.mirrorBaseUrl,
                id,
                { repo: entry.repo, version: candidate.version, files: candidate.files },
                this.plugin.fetchFn
              );
              entry.installedVersion = candidate.version;
              this.plugin.pendingUpdates.delete(id);
              await this.plugin.saveSettings();
              new Notice(`Updated ${id} to v${entry.installedVersion}`);
              this.display();
            } catch (error) {
              new Notice(`Failed to update ${id}: ${(error as Error).message}`);
            }
          })
        );
      }

      setting.addToggle((toggle) =>
        toggle
          .setValue(entry.allowPrerelease)
          .setTooltip('Allow prerelease versions')
          .onChange(async (value) => {
            entry.allowPrerelease = value;
            await this.plugin.saveSettings();
          })
      );

      setting.addButton((button) =>
        button.setButtonText('Remove').onClick(async () => {
          try {
            await removePlugin(this.getAdapter(), this.getPluginManager(), id);
            delete this.plugin.settings.trackedPlugins[id];
            this.plugin.pendingUpdates.delete(id);
            await this.plugin.saveSettings();
            new Notice(`Removed ${id}`);
            this.display();
          } catch (error) {
            new Notice(`Failed to remove ${id}: ${(error as Error).message}`);
          }
        })
      );
    }
  }

  private async renderRegistry(containerEl: HTMLElement): Promise<void> {
    let entries: RegistryEntry[];
    try {
      const index = await fetchIndex(this.plugin.settings.mirrorBaseUrl, this.plugin.fetchFn);
      entries = index.plugins;
    } catch (error) {
      containerEl.createEl('p', { text: `Failed to load registry: ${(error as Error).message}` });
      return;
    }

    for (const entry of entries) {
      if (this.plugin.settings.trackedPlugins[entry.id]) continue;

      new Setting(containerEl)
        .setName(entry.name)
        .setDesc(`${entry.description} — by ${entry.author} — latest v${entry.latestVersion ?? 'n/a'}`)
        .addButton((button) =>
          button.setButtonText('Install').onClick(async () => {
            try {
              const versions = await fetchVersions(this.plugin.settings.mirrorBaseUrl, entry.repo, this.plugin.fetchFn);
              const sorted = sortVersionsNewestFirst(versions.versions);
              const candidate = selectUpdateCandidate(sorted, false);
              if (!candidate) {
                new Notice(`No installable version found for ${entry.name}`);
                return;
              }
              await installPluginVersion(
                this.getAdapter(),
                this.getPluginManager(),
                this.plugin.settings.mirrorBaseUrl,
                entry.id,
                { repo: entry.repo, version: candidate.version, files: candidate.files },
                this.plugin.fetchFn
              );
              this.plugin.settings.trackedPlugins[entry.id] = {
                repo: entry.repo,
                installedVersion: candidate.version,
                allowPrerelease: false,
              };
              await this.plugin.saveSettings();
              new Notice(`Installed ${entry.name} v${candidate.version}`);
              this.display();
            } catch (error) {
              new Notice(`Failed to install ${entry.name}: ${(error as Error).message}`);
            }
          })
        );
    }
  }
}
