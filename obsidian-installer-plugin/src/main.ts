import { Notice, Plugin } from 'obsidian';
import { mergeSettings, type PluginSettings } from './settings';
import { checkForUpdates, applyUpdate, type UpdateCheckResult } from './updater';
import { MirrorInstallerSettingTab } from './settingsTab';
import type { VaultAdapterLike, PluginManagerLike } from './installer';

export default class MirrorInstallerPlugin extends Plugin {
  settings!: PluginSettings;
  pendingUpdates: Map<string, UpdateCheckResult> = new Map();

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    this.addSettingTab(new MirrorInstallerSettingTab(this.app, this));

    this.addCommand({
      id: 'check-for-mirror-plugin-updates',
      name: 'Check for mirrored plugin updates',
      callback: () => {
        void this.runUpdateCheck();
      },
    });

    if (this.settings.autoCheckOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        void this.runUpdateCheck();
      });
    }
  }

  onunload(): void {
    // addCommand/addSettingTab registrations are cleaned up automatically by Obsidian;
    // nothing else is registered outside the plugin lifecycle, so there is nothing to tear down here.
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private getAdapter(): VaultAdapterLike {
    return this.app.vault.adapter as unknown as VaultAdapterLike;
  }

  private getPluginManager(): PluginManagerLike {
    return (this.app as unknown as { plugins: PluginManagerLike }).plugins;
  }

  async runUpdateCheck(): Promise<void> {
    const results = await checkForUpdates(this.settings.mirrorBaseUrl, this.settings.trackedPlugins, fetch);
    const updatesAvailable = results.filter((r) => r.status === 'update-available');
    const errors = results.filter((r) => r.status === 'error');

    this.pendingUpdates.clear();
    for (const result of updatesAvailable) {
      this.pendingUpdates.set(result.pluginId, result);
    }

    if (this.settings.autoInstallUpdates && updatesAvailable.length > 0) {
      const installedIds: string[] = [];
      for (const result of updatesAvailable) {
        if (!result.candidate) continue;
        const tracked = this.settings.trackedPlugins[result.pluginId];
        try {
          await applyUpdate(
            this.getAdapter(),
            this.getPluginManager(),
            this.settings.mirrorBaseUrl,
            result.pluginId,
            tracked.repo,
            result.candidate,
            fetch
          );
          tracked.installedVersion = result.candidate.version;
          installedIds.push(result.pluginId);
          this.pendingUpdates.delete(result.pluginId);
        } catch (error) {
          console.error(`Failed to auto-install update for ${result.pluginId}`, error);
        }
      }
      if (installedIds.length > 0) {
        await this.saveSettings();
        new Notice(`Updated ${installedIds.length} mirrored plugin(s): ${installedIds.join(', ')}`);
      }
    }

    for (const errorResult of errors) {
      console.error(`Update check failed for ${errorResult.pluginId}: ${errorResult.error}`);
    }
  }
}
