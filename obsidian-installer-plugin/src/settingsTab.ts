import { App, Notice, PluginSettingTab, SearchComponent, Setting } from 'obsidian';
import type MirrorInstallerPlugin from './main';
import { fetchIndex, fetchVersions, type RegistryEntry, type VersionEntry } from './registry';
import { sortVersionsNewestFirst, selectUpdateCandidate } from './versionCompare';
import { installPluginVersion, removePlugin, type VaultAdapterLike, type PluginManagerLike } from './installer';

export class MirrorInstallerSettingTab extends PluginSettingTab {
  plugin: MirrorInstallerPlugin;
  private installedSearchQuery = '';
  private registrySearchQuery = '';

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
        button.setButtonText('Check now').onClick(() => {
          this.display();
        })
      );

    // Matches Obsidian's own native "Installed plugins" DOM exactly:
    // .setting-group directly containing .setting-item.setting-item-heading,
    // then the search row, then a .setting-items wrapper for the rows — all
    // as direct children, no extra wrapper divs. Obsidian's grouped styling
    // (padding/border reset) appears to key off that direct-child structure
    // rather than matching any .setting-item at any depth, so an extra
    // wrapper div in between (as an earlier version of this had) was enough
    // to break the alignment between the heading and the rows.
    const installedGroup = containerEl.createDiv({ cls: 'setting-group' });
    const installedHeading = new Setting(installedGroup).setName('Installed mirrored plugins').setHeading();
    installedGroup.createEl('p', { text: 'Checking installed mirrored plugins for updates…' });

    const registryGroup = containerEl.createDiv({ cls: 'setting-group' });
    const registryHeading = new Setting(registryGroup).setName('Available in mirror').setHeading();
    registryGroup.createEl('p', { text: 'Loading…' });

    void this.loadPluginLists(installedGroup, installedHeading.settingEl, registryGroup, registryHeading.settingEl);
  }

  /**
   * Removes everything in a .setting-group except its heading row, so a
   * re-render can rebuild the search box + items list as fresh direct
   * children of the group without disturbing (or duplicating) the heading.
   */
  private clearGroupBody(groupEl: HTMLElement, headingEl: HTMLElement): void {
    for (const child of Array.from(groupEl.children)) {
      if (child !== headingEl) child.remove();
    }
  }

  /**
   * Obsidian's native group search bar is a bare SearchComponent inside
   * .setting-group-search > .search-input-container — no name label, no
   * .setting-item-control wrapper. A full Setting().addSearch() row (name +
   * control) is a different, wider shape, which is why it looked oversized
   * next to the native-structured heading/rows.
   */
  private createGroupSearch(
    groupEl: HTMLElement,
    placeholder: string,
    value: string,
    onChange: (value: string) => void
  ): void {
    const wrapper = groupEl.createDiv({ cls: 'setting-group-search' });
    const inputContainer = wrapper.createDiv({ cls: 'search-input-container' });
    new SearchComponent(inputContainer).setPlaceholder(placeholder).setValue(value).onChange(onChange);
  }

  /**
   * Runs a full update check first (this adopts any plugin already installed
   * on disk — via Obsidian's built-in browser, BRAT, or a manual copy — and
   * populates plugin.pendingUpdates) so the "Install update" button has data
   * to render on the very first paint, not just after a second open. Only
   * then fetches the registry for the "Available in mirror" list, since that
   * needs full entry metadata (name/description/author) the update check
   * doesn't return.
   */
  private async loadPluginLists(
    installedGroup: HTMLElement,
    installedHeadingEl: HTMLElement,
    registryGroup: HTMLElement,
    registryHeadingEl: HTMLElement
  ): Promise<void> {
    await this.plugin.runUpdateCheck();

    let entries: RegistryEntry[];
    try {
      const index = await fetchIndex(this.plugin.settings.mirrorBaseUrl, this.plugin.fetchFn);
      entries = index.plugins;
    } catch (error) {
      this.clearGroupBody(registryGroup, registryHeadingEl);
      registryGroup.createEl('p', { text: `Failed to load registry: ${(error as Error).message}` });
      this.renderInstalledPlugins(installedGroup, installedHeadingEl);
      return;
    }

    this.renderInstalledPlugins(installedGroup, installedHeadingEl);
    this.renderRegistry(registryGroup, registryHeadingEl, entries);
  }

  private renderInstalledPlugins(groupEl: HTMLElement, headingEl: HTMLElement): void {
    this.clearGroupBody(groupEl, headingEl);
    const tracked = this.plugin.settings.trackedPlugins;
    if (Object.keys(tracked).length === 0) {
      groupEl.createEl('p', { text: 'No mirrored plugins installed yet.' });
      return;
    }

    // listEl is referenced inside the search callback below before its own
    // declaration is reached — safe because the callback only runs later, on
    // user input, by which point listEl is assigned. Declared after the
    // search box (rather than before) so the two end up in the right visual
    // order: search box above the items list, matching the native
    // heading → search → items structure.
    this.createGroupSearch(groupEl, 'Filter by name or plugin id…', this.installedSearchQuery, (value) => {
      this.installedSearchQuery = value;
      this.renderInstalledList(listEl);
    });

    const listEl = groupEl.createDiv({ cls: 'setting-items' });
    this.renderInstalledList(listEl);
  }

  private renderInstalledList(containerEl: HTMLElement): void {
    containerEl.empty();
    const tracked = this.plugin.settings.trackedPlugins;
    const query = this.installedSearchQuery.trim().toLowerCase();
    const ids = Object.keys(tracked).filter((id) => {
      if (!query) return true;
      const name = tracked[id].name;
      return id.toLowerCase().includes(query) || (name?.toLowerCase().includes(query) ?? false);
    });

    if (ids.length === 0) {
      containerEl.createEl('p', { text: 'No installed plugins match your search.' });
      return;
    }

    for (const id of ids) {
      const entry = tracked[id];
      const pending = this.plugin.pendingUpdates.get(id);
      const setting = new Setting(containerEl)
        .setName(entry.name ?? id)
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

  private renderRegistry(groupEl: HTMLElement, headingEl: HTMLElement, entries: RegistryEntry[]): void {
    this.clearGroupBody(groupEl, headingEl);

    // listEl is referenced inside the search callback below before its own
    // declaration — safe, since the callback only runs later on user input,
    // by which point listEl is assigned. Declared after the search box so
    // DOM order stays search-box-above-items, matching the native
    // heading → search → items structure.
    this.createGroupSearch(groupEl, 'Filter by name, description, or author…', this.registrySearchQuery, (value) => {
      this.registrySearchQuery = value;
      this.renderRegistryList(listEl, entries);
    });

    const listEl = groupEl.createDiv({ cls: 'setting-items' });

    this.renderRegistryList(listEl, entries);
  }

  private renderRegistryList(containerEl: HTMLElement, entries: RegistryEntry[]): void {
    containerEl.empty();
    const query = this.registrySearchQuery.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (this.plugin.settings.trackedPlugins[entry.id]) return false;
      if (!query) return true;
      return (
        entry.name.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query) ||
        entry.author.toLowerCase().includes(query)
      );
    });

    if (filtered.length === 0) {
      containerEl.createEl('p', {
        text: query ? 'No available plugins match your search.' : 'No plugins available.',
      });
      return;
    }

    for (const entry of filtered) {
      const setting = new Setting(containerEl)
        .setName(entry.name)
        .setDesc(`${entry.description} — by ${entry.author} — latest v${entry.latestVersion ?? 'n/a'}`)
        .addButton((button) =>
          button
            .setButtonText('Install')
            .setCta()
            .onClick(async () => {
              try {
                const versions = await fetchVersions(this.plugin.settings.mirrorBaseUrl, entry.repo, this.plugin.fetchFn);
                const sorted = sortVersionsNewestFirst(versions.versions);
                const candidate = selectUpdateCandidate(sorted, false);
                if (!candidate) {
                  new Notice(`No installable version found for ${entry.name}`);
                  return;
                }
                await this.installVersion(entry, candidate);
              } catch (error) {
                new Notice(`Failed to install ${entry.name}: ${(error as Error).message}`);
              }
            })
        );

      // Nested inside the Setting's own description element (not appended as a
      // sibling of containerEl) so it stays inside this plugin's row instead of
      // floating below it.
      const versionRow = setting.descEl.createEl('div');
      versionRow.style.marginTop = '0.35rem';
      const pickVersionLink = versionRow.createEl('a', { text: 'Install a specific version…', href: '#' });
      pickVersionLink.style.fontSize = '0.8em';
      pickVersionLink.style.opacity = '0.7';
      pickVersionLink.addEventListener('click', (evt) => {
        evt.preventDefault();
        pickVersionLink.remove();
        void this.renderVersionPicker(versionRow, entry);
      });
    }
  }

  /**
   * Deliberately tucked behind a small, muted link rather than shown next to
   * the main Install button — most installs should just be one click on
   * "Install" (latest), not a version choice the user has to make first.
   */
  private async renderVersionPicker(containerEl: HTMLElement, entry: RegistryEntry): Promise<void> {
    containerEl.setText('Loading versions…');
    let sorted: VersionEntry[];
    try {
      const versions = await fetchVersions(this.plugin.settings.mirrorBaseUrl, entry.repo, this.plugin.fetchFn);
      sorted = sortVersionsNewestFirst(versions.versions);
    } catch (error) {
      containerEl.setText(`Failed to load versions: ${(error as Error).message}`);
      return;
    }

    containerEl.empty();
    if (sorted.length === 0) {
      containerEl.setText('No versions available.');
      return;
    }

    const select = containerEl.createEl('select');
    for (const version of sorted) {
      select.createEl('option', {
        value: version.version,
        text: version.prerelease ? `${version.version} (prerelease)` : version.version,
      });
    }

    const installButton = containerEl.createEl('button', { text: 'Install' });
    installButton.style.marginLeft = '0.5rem';
    installButton.addEventListener('click', async () => {
      const chosen = sorted.find((v) => v.version === select.value);
      if (!chosen) return;
      await this.installVersion(entry, chosen);
    });
  }

  private async installVersion(entry: RegistryEntry, candidate: VersionEntry): Promise<void> {
    try {
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
        name: entry.name,
      };
      await this.plugin.saveSettings();
      new Notice(`Installed ${entry.name} v${candidate.version}`);
      this.display();
    } catch (error) {
      new Notice(`Failed to install ${entry.name}: ${(error as Error).message}`);
    }
  }
}
