import { App, Notice, PluginSettingTab, SearchComponent, Setting } from 'obsidian';
import type MirrorInstallerPlugin from './main';
import { fetchIndex, fetchVersions, type RegistryEntry, type VersionEntry } from './registry';
import { sortVersionsNewestFirst, selectUpdateCandidate } from './versionCompare';
import {
  installPluginVersion,
  removePlugin,
  type VaultAdapterLike,
  type PluginManagerLike,
} from './installer';
import { checkSelfUpdate, downloadSelfUpdate } from './selfUpdate';
import type { TrackedPlugin } from './settings';
import { startWalkingPenguin, type PenguinController } from './penguin';
import { t } from './i18n';

export class MirrorInstallerSettingTab extends PluginSettingTab {
  plugin: MirrorInstallerPlugin;
  private installedSearchQuery = '';
  private registrySearchQuery = '';
  private advancedPopoverEl: HTMLElement | null = null;
  private advancedPopoverCleanup: (() => void) | null = null;
  private penguin: PenguinController | null = null;
  private globalAdvancedExpanded = false;

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

  hide(): void {
    // The popover and the penguin are both attached to document.body (see
    // openAdvancedPopover / startWalkingPenguin), so neither would otherwise
    // be cleaned up by Obsidian closing this tab's own containerEl.
    this.closeAdvancedPopover();
    this.penguin?.stop();
    this.penguin = null;
  }

  /**
   * (Re)starts the penguin controller from current settings. Called once
   * per tab-open from display() (guarded so re-renders while the tab stays
   * open don't cut off a mid-walk penguin), and again, unconditionally,
   * whenever the settings below actually change — so toggling either one
   * takes effect immediately instead of requiring the tab to be reopened.
   */
  private applyPenguinSettings(): void {
    this.penguin?.stop();
    this.penguin = startWalkingPenguin(document.body, this.containerEl, {
      enabled: this.plugin.settings.showPenguin,
      ignoreReducedMotion: this.plugin.settings.penguinIgnoreReducedMotion,
    });
  }

  display(): void {
    this.closeAdvancedPopover();
    if (!this.penguin) {
      this.applyPenguinSettings();
    }
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t('settings.mirrorBaseUrl.name'))
      .setDesc(t('settings.mirrorBaseUrl.desc'))
      .addText((text) =>
        text.setValue(this.plugin.settings.mirrorBaseUrl).onChange(async (value) => {
          this.plugin.settings.mirrorBaseUrl = value;
          await this.plugin.saveSettings();
        })
      );

    // This plugin's own version lives here, among the other global settings
    // — not as a separate section, and not inside "Installed mirrored
    // plugins" (which only ever lists *other* plugins; see checkForUpdates'
    // excludeIds in main.ts). Checked independently of the registry fetch
    // below — see renderSelfVersionRow.
    const selfVersionSetting = new Setting(containerEl)
      .setName(t('self.name'))
      .setDesc(t('self.status.checking', { version: this.plugin.manifest.version }));

    new Setting(containerEl)
      .setName(t('settings.autoCheckOnStartup.name'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoCheckOnStartup).onChange(async (value) => {
          this.plugin.settings.autoCheckOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t('settings.autoInstallUpdates.name'))
      .setDesc(t('settings.autoInstallUpdates.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoInstallUpdates).onChange(async (value) => {
          this.plugin.settings.autoInstallUpdates = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t('settings.checkNow.name'))
      .addButton((button) =>
        button.setButtonText(t('settings.checkNow.button')).onClick(() => {
          this.display();
        })
      );

    // Same native .setting-group + .setHeading() pattern as the
    // Installed/Available groups below — a visually separate section, kept
    // out of the main top-level settings list above. Collapsed by default;
    // the heading row's own button reveals the actual settings, rather than
    // showing them unconditionally. Expanding/collapsing only re-renders
    // this group's own body (see renderAdvancedItems) — it must NOT call
    // this.display(), which would also re-run loadPluginLists() (a fresh
    // runUpdateCheck()/fetchIndex() and a full Installed/Available
    // rebuild) just to toggle a visibility flag.
    const advancedGroup = containerEl.createDiv({ cls: 'setting-group' });
    const advancedHeading = new Setting(advancedGroup).setName(t('settings.advanced.heading')).setHeading();
    advancedHeading.addButton((button) =>
      button
        .setButtonText(this.globalAdvancedExpanded ? t('settings.advanced.hide') : t('settings.advanced.show'))
        .onClick(() => {
          this.globalAdvancedExpanded = !this.globalAdvancedExpanded;
          button.setButtonText(this.globalAdvancedExpanded ? t('settings.advanced.hide') : t('settings.advanced.show'));
          this.renderAdvancedItems(advancedGroup, advancedHeading.settingEl);
        })
    );
    this.renderAdvancedItems(advancedGroup, advancedHeading.settingEl);

    // Matches Obsidian's own native "Installed plugins" DOM exactly:
    // .setting-group directly containing .setting-item.setting-item-heading,
    // then the search row, then a .setting-items wrapper for the rows — all
    // as direct children, no extra wrapper divs. Obsidian's grouped styling
    // (padding/border reset) appears to key off that direct-child structure
    // rather than matching any .setting-item at any depth, so an extra
    // wrapper div in between (as an earlier version of this had) was enough
    // to break the alignment between the heading and the rows.
    const installedGroup = containerEl.createDiv({ cls: 'setting-group' });
    const installedHeading = new Setting(installedGroup).setName(t('installed.heading')).setHeading();
    installedGroup.createEl('p', { text: t('installed.checking') });

    const registryGroup = containerEl.createDiv({ cls: 'setting-group' });
    const registryHeading = new Setting(registryGroup).setName(t('registry.heading')).setHeading();
    registryGroup.createEl('p', { text: t('registry.loading') });

    void this.loadPluginLists(
      selfVersionSetting,
      installedGroup,
      installedHeading.settingEl,
      registryGroup,
      registryHeading.settingEl
    );
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
   * The Advanced group's collapsible body — cleared and rebuilt on its own
   * (via clearGroupBody, same as Installed/Registry) whenever the expand
   * state changes, independent of the rest of the settings tab. The
   * heading row itself (and its Show/Hide button, added separately in
   * display()) is left untouched.
   */
  private renderAdvancedItems(groupEl: HTMLElement, headingEl: HTMLElement): void {
    this.clearGroupBody(groupEl, headingEl);
    if (!this.globalAdvancedExpanded) return;

    // Same .setting-items wrapper the Installed/Available rows use below —
    // without it, these render at the wider top-level .setting-item width
    // instead of the narrower grouped-list width.
    const advancedItems = groupEl.createDiv({ cls: 'setting-items' });

    new Setting(advancedItems)
      .setName(t('settings.showPenguin.name'))
      .setDesc(t('settings.showPenguin.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showPenguin).onChange(async (value) => {
          this.plugin.settings.showPenguin = value;
          await this.plugin.saveSettings();
          this.applyPenguinSettings();
        })
      );

    new Setting(advancedItems)
      .setName(t('settings.penguinIgnoreReducedMotion.name'))
      .setDesc(t('settings.penguinIgnoreReducedMotion.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.penguinIgnoreReducedMotion).onChange(async (value) => {
          this.plugin.settings.penguinIgnoreReducedMotion = value;
          await this.plugin.saveSettings();
          this.applyPenguinSettings();
        })
      );
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
   * doesn't return. That same registry fetch is reused for this plugin's own
   * version row, rather than a second, redundant fetch.
   */
  private async loadPluginLists(
    selfVersionSetting: Setting,
    installedGroup: HTMLElement,
    installedHeadingEl: HTMLElement,
    registryGroup: HTMLElement,
    registryHeadingEl: HTMLElement
  ): Promise<void> {
    // Independent of the registry fetch below — it hits its own fixed
    // endpoint, so a slow or failing 200-plugin registry never blocks or
    // delays this plugin's own version check.
    void this.renderSelfVersionRow(selfVersionSetting);

    await this.plugin.runUpdateCheck();

    let entries: RegistryEntry[];
    try {
      const index = await fetchIndex(this.plugin.settings.mirrorBaseUrl, this.plugin.fetchFn);
      entries = index.plugins;
    } catch (error) {
      this.clearGroupBody(registryGroup, registryHeadingEl);
      registryGroup.createEl('p', { text: t('registry.loadError', { message: (error as Error).message }) });
      this.renderInstalledPlugins(installedGroup, installedHeadingEl);
      return;
    }

    const selfId = this.plugin.manifest.id;
    const otherEntries = entries.filter((e) => e.id !== selfId);

    this.renderInstalledPlugins(installedGroup, installedHeadingEl);
    this.renderRegistry(registryGroup, registryHeadingEl, otherEntries);
  }

  /**
   * Self-update is deliberately kept out of the generic Installed/Available
   * flow (see checkForUpdates' excludeIds in main.ts): that flow's "Remove"
   * button would delete this plugin's own running folder, and its "Install
   * update" button calls enablePlugin on a plugin that's already enabled and
   * currently executing — undefined behavior in Obsidian. This downloads the
   * new files only, then asks the user to reload Obsidian to actually apply
   * them, rather than attempting any in-place self-reload.
   */
  private async renderSelfVersionRow(setting: Setting): Promise<void> {
    const selfId = this.plugin.manifest.id;
    const currentVersion = this.plugin.manifest.version;

    const result = await checkSelfUpdate(this.plugin.settings.mirrorBaseUrl, currentVersion, this.plugin.fetchFn);

    if (result.status === 'error') {
      setting.setDesc(t('self.status.error', { version: currentVersion, message: result.error }));
      return;
    }
    if (result.status === 'up-to-date') {
      setting.setDesc(t('self.status.upToDate', { version: currentVersion }));
      return;
    }

    setting.setDesc(t('self.status.updateAvailable', { version: currentVersion, newVersion: result.version }));
    setting.addButton((button) =>
      button
        .setButtonText(t('self.button.update'))
        .setCta()
        .onClick(async () => {
          try {
            await downloadSelfUpdate(this.getAdapter(), this.plugin.settings.mirrorBaseUrl, selfId, this.plugin.fetchFn);
            new Notice(t('notice.selfUpdated', { version: result.version }), 10000);
          } catch (error) {
            new Notice(t('notice.selfUpdateFailed', { message: (error as Error).message }));
          }
        })
    );
  }

  private renderInstalledPlugins(groupEl: HTMLElement, headingEl: HTMLElement): void {
    this.clearGroupBody(groupEl, headingEl);
    const tracked = this.plugin.settings.trackedPlugins;
    if (Object.keys(tracked).length === 0) {
      groupEl.createEl('p', { text: t('installed.empty') });
      return;
    }

    // listEl is referenced inside the search callback below before its own
    // declaration is reached — safe because the callback only runs later, on
    // user input, by which point listEl is assigned. Declared after the
    // search box (rather than before) so the two end up in the right visual
    // order: search box above the items list, matching the native
    // heading → search → items structure.
    this.createGroupSearch(groupEl, t('installed.searchPlaceholder'), this.installedSearchQuery, (value) => {
      this.installedSearchQuery = value;
      this.renderInstalledList(listEl);
    });

    const listEl = groupEl.createDiv({ cls: 'setting-items' });
    this.renderInstalledList(listEl);
  }

  /**
   * Plain text + a DocumentFragment badge rather than a single translated
   * string, so the badge can carry its own inline styling without needing a
   * new stylesheet — see the file-level note on inline styles elsewhere in
   * this file (e.g. renderRegistryList's version-picker link).
   */
  private buildInstalledDesc(entry: TrackedPlugin, pending?: { candidate?: { version: string } }): DocumentFragment {
    const frag = document.createDocumentFragment();
    const text = pending?.candidate
      ? t('installed.status.updateAvailable', { version: entry.installedVersion, newVersion: pending.candidate.version })
      : t('installed.status.upToDate', { version: entry.installedVersion });
    frag.appendChild(document.createTextNode(text));
    if (entry.allowPrerelease) {
      const badge = document.createElement('span');
      badge.textContent = t('installed.badge.prerelease');
      badge.style.marginLeft = '0.5rem';
      badge.style.padding = '1px 8px';
      badge.style.borderRadius = '10px';
      badge.style.fontSize = '0.8em';
      badge.style.fontWeight = '600';
      badge.style.color = '#7c2d12';
      badge.style.background = '#fed7aa';
      frag.appendChild(badge);
    }
    return frag;
  }

  private closeAdvancedPopover(): void {
    this.advancedPopoverCleanup?.();
    this.advancedPopoverCleanup = null;
    this.advancedPopoverEl?.remove();
    this.advancedPopoverEl = null;
  }

  /**
   * Obsidian doesn't expose a public component for an anchored popover with
   * rich content (only the plain-list Menu class), so this is a small,
   * self-contained one: a fixed-position div using Obsidian's own ".menu"
   * class for native-looking chrome (border/shadow/background) without any
   * custom CSS, holding a single Setting row for the actual control.
   */
  private openAdvancedPopover(anchorEl: HTMLElement, id: string, entry: TrackedPlugin): void {
    const reopeningSameRow = this.advancedPopoverEl?.dataset.forId === id;
    this.closeAdvancedPopover();
    if (reopeningSameRow) return;

    const rect = anchorEl.getBoundingClientRect();
    const popover = document.body.createDiv({ cls: 'menu' });
    popover.dataset.forId = id;
    popover.style.position = 'fixed';
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.right = `${window.innerWidth - rect.right}px`;
    popover.style.width = '300px';
    popover.style.padding = '8px 12px';

    popover.createDiv({
      text: t('installed.advanced.heading', { name: entry.name ?? id }),
    }).style.cssText = 'font-weight: 600; margin-bottom: 4px;';

    new Setting(popover)
      .setName(t('installed.advanced.allowPrerelease.label'))
      .setDesc(t('installed.advanced.allowPrerelease.desc'))
      .addToggle((toggle) =>
        toggle.setValue(entry.allowPrerelease).onChange(async (value) => {
          entry.allowPrerelease = value;
          await this.plugin.saveSettings();
          this.closeAdvancedPopover();
          this.display();
        })
      );

    this.advancedPopoverEl = popover;

    const onDocClick = (evt: MouseEvent) => {
      if (!popover.contains(evt.target as Node) && evt.target !== anchorEl && !anchorEl.contains(evt.target as Node)) {
        this.closeAdvancedPopover();
      }
    };
    const onKeydown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') this.closeAdvancedPopover();
    };
    // Deferred so the same click that opened the popover (which is still
    // bubbling to document when this runs) doesn't immediately close it.
    window.setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKeydown);
    }, 0);
    this.advancedPopoverCleanup = () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKeydown);
    };
  }

  private renderInstalledList(containerEl: HTMLElement): void {
    containerEl.empty();
    const tracked = this.plugin.settings.trackedPlugins;
    const selfId = this.plugin.manifest.id;
    const query = this.installedSearchQuery.trim().toLowerCase();
    const ids = Object.keys(tracked).filter((id) => {
      if (id === selfId) return false;
      if (!query) return true;
      const name = tracked[id].name;
      return id.toLowerCase().includes(query) || (name?.toLowerCase().includes(query) ?? false);
    });

    if (ids.length === 0) {
      containerEl.createEl('p', { text: t('installed.noMatch') });
      return;
    }

    for (const id of ids) {
      const entry = tracked[id];
      const pending = this.plugin.pendingUpdates.get(id);
      const setting = new Setting(containerEl).setName(entry.name ?? id).setDesc(this.buildInstalledDesc(entry, pending));

      if (pending?.candidate) {
        const candidate = pending.candidate;
        setting.addButton((button) =>
          button.setButtonText(t('installed.button.installUpdate')).onClick(async () => {
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
              new Notice(t('notice.updated', { id, version: entry.installedVersion }));
              this.display();
            } catch (error) {
              new Notice(t('notice.updateFailed', { id, message: (error as Error).message }));
            }
          })
        );
      }

      setting.addButton((button) =>
        button.setButtonText(t('installed.button.advanced')).onClick((evt) => {
          evt.stopPropagation();
          this.openAdvancedPopover(button.buttonEl, id, entry);
        })
      );

      setting.addButton((button) =>
        button.setButtonText(t('installed.button.remove')).onClick(async () => {
          try {
            await removePlugin(this.getAdapter(), this.getPluginManager(), id);
            delete this.plugin.settings.trackedPlugins[id];
            this.plugin.pendingUpdates.delete(id);
            await this.plugin.saveSettings();
            new Notice(t('notice.removed', { id }));
            this.display();
          } catch (error) {
            new Notice(t('notice.removeFailed', { id, message: (error as Error).message }));
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
    this.createGroupSearch(groupEl, t('registry.searchPlaceholder'), this.registrySearchQuery, (value) => {
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
        text: query ? t('registry.noMatch') : t('registry.empty'),
      });
      return;
    }

    for (const entry of filtered) {
      const setting = new Setting(containerEl)
        .setName(entry.name)
        .setDesc(
          t('registry.desc', {
            description: entry.description,
            author: entry.author,
            version: entry.latestVersion ?? 'n/a',
          })
        )
        .addButton((button) =>
          button
            .setButtonText(t('registry.button.install'))
            .setCta()
            .onClick(async () => {
              try {
                const versions = await fetchVersions(this.plugin.settings.mirrorBaseUrl, entry.repo, this.plugin.fetchFn);
                const sorted = sortVersionsNewestFirst(versions.versions);
                const candidate = selectUpdateCandidate(sorted, false);
                if (!candidate) {
                  new Notice(t('notice.noInstallableVersion', { name: entry.name }));
                  return;
                }
                await this.installVersion(entry, candidate);
              } catch (error) {
                new Notice(t('notice.installFailed', { name: entry.name, message: (error as Error).message }));
              }
            })
        );

      // Nested inside the Setting's own description element (not appended as a
      // sibling of containerEl) so it stays inside this plugin's row instead of
      // floating below it.
      const versionRow = setting.descEl.createEl('div');
      versionRow.style.marginTop = '0.35rem';
      const pickVersionLink = versionRow.createEl('a', { text: t('registry.pickVersionLink'), href: '#' });
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
    containerEl.setText(t('registry.versionPicker.loading'));
    let sorted: VersionEntry[];
    try {
      const versions = await fetchVersions(this.plugin.settings.mirrorBaseUrl, entry.repo, this.plugin.fetchFn);
      sorted = sortVersionsNewestFirst(versions.versions);
    } catch (error) {
      containerEl.setText(t('registry.versionPicker.loadError', { message: (error as Error).message }));
      return;
    }

    containerEl.empty();
    if (sorted.length === 0) {
      containerEl.setText(t('registry.versionPicker.empty'));
      return;
    }

    const select = containerEl.createEl('select');
    for (const version of sorted) {
      select.createEl('option', {
        value: version.version,
        text: version.prerelease
          ? t('registry.versionPicker.prereleaseLabel', { version: version.version })
          : version.version,
      });
    }

    const installButton = containerEl.createEl('button', { text: t('registry.button.install') });
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
      new Notice(t('notice.installed', { name: entry.name, version: candidate.version }));
      this.display();
    } catch (error) {
      new Notice(t('notice.installFailed', { name: entry.name, message: (error as Error).message }));
    }
  }
}
