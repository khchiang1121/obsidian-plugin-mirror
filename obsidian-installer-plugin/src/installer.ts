import type { FetchLike } from './obsidianFetch';
import type { RegistryEntry } from './registry';
import type { TrackedPlugin } from './settings';

export interface VaultAdapterLike {
  mkdir(path: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  read(path: string): Promise<string>;
  /**
   * Obsidian's real DataAdapter.exists is a documented public method,
   * unlike everything in PluginManagerLike below — used to authoritatively
   * check whether a path is actually gone (see
   * pruneUninstalledTrackedPlugins), rather than inferring absence from a
   * read() failure, which could just as easily mean a transient/unrelated
   * read error and shouldn't be treated the same as "no longer installed".
   */
  exists(path: string): Promise<boolean>;
}

export interface PluginManagerLike {
  enablePlugin(id: string): Promise<void>;
  disablePlugin(id: string): Promise<void>;
  /**
   * Rescans .obsidian/plugins/*\/manifest.json — the same internal method
   * Obsidian's own Community Plugins page calls from its manual reload
   * button. Not in the public Obsidian API (undocumented, like
   * enablePlugin/disablePlugin above), but well-established via BRAT's use
   * of it for exactly this problem: without it, a brand-new plugin folder
   * isn't recognized until the user manually reloads that native page, and
   * an updated plugin's new version isn't reflected there either, since
   * enable/disable manage the running instance, not this separate manifest
   * cache.
   */
  loadManifests(): Promise<void>;
}

export interface InstallableVersion {
  repo: string;
  version: string;
  files: string[];
}

/**
 * Downloads a version's files into the plugin's folder without touching the
 * plugin manager. Split out from installPluginVersion so a plugin can
 * download its own update without calling enablePlugin on itself while it's
 * the code currently executing — see selfUpdate.ts.
 */
export async function downloadPluginFiles(
  adapter: VaultAdapterLike,
  mirrorBaseUrl: string,
  pluginId: string,
  version: InstallableVersion,
  fetchFn: FetchLike = fetch
): Promise<void> {
  const pluginDir = `.obsidian/plugins/${pluginId}`;
  try {
    await adapter.mkdir(pluginDir);
  } catch {
    // Directory already exists (re-install/update) — fine.
  }

  const base = mirrorBaseUrl.replace(/\/+$/, '');
  for (const file of version.files) {
    const url = `${base}/plugins/${version.repo}/${version.version}/${file}`;
    const response = await fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status}`);
    }
    const content = await response.text();
    await adapter.write(`${pluginDir}/${file}`, content);
  }
}

export async function installPluginVersion(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
  mirrorBaseUrl: string,
  pluginId: string,
  version: InstallableVersion,
  fetchFn: FetchLike = fetch
): Promise<void> {
  await downloadPluginFiles(adapter, mirrorBaseUrl, pluginId, version, fetchFn);
  // Rescan first, so Obsidian's manifest cache reflects what's actually on
  // disk (both for a brand-new plugin id it's never seen, and for an
  // updated version number) before touching the enabled state at all.
  await pluginManager.loadManifests();
  // A disable+enable cycle, not just enable — enabling an already-enabled
  // plugin is a no-op in Obsidian's own implementation (matches BRAT's
  // approach to the same problem), which would otherwise leave the old
  // code running in memory even after the manifest rescan above.
  // disablePlugin is expected to throw harmlessly here on a fresh install
  // (nothing enabled yet to disable) — proceed to enable either way.
  try {
    await pluginManager.disablePlugin(pluginId);
  } catch {
    // Not currently enabled — fine, fall through to enable below.
  }
  await pluginManager.enablePlugin(pluginId);
}

/**
 * Reads the version actually on disk for an installed plugin, straight from
 * its manifest.json — the ground truth Obsidian itself uses. Returns null if
 * it can't be read (plugin folder missing/corrupt), so callers can fall back
 * to their own cached belief about what's installed.
 */
export async function readInstalledManifestVersion(
  adapter: VaultAdapterLike,
  pluginId: string
): Promise<string | null> {
  try {
    const raw = await adapter.read(`.obsidian/plugins/${pluginId}/manifest.json`);
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Finds registry plugins that are already installed on disk (e.g. via
 * Obsidian's built-in Community Plugins browser, BRAT, or a manual copy)
 * but aren't yet in trackedPlugins, and folds them in — using the real
 * on-disk manifest.json version as ground truth. Also backfills/syncs the
 * display name of already-tracked plugins from the registry, so the
 * "Installed" list never falls back to showing a bare plugin id. Mutates
 * trackedPlugins in place and returns the ids that were newly adopted (name
 * syncs on already-tracked plugins aren't included).
 */
export async function adoptUntrackedInstalledPlugins(
  adapter: VaultAdapterLike,
  trackedPlugins: Record<string, TrackedPlugin>,
  registryEntries: RegistryEntry[]
): Promise<string[]> {
  // Disk reads run concurrently rather than one at a time — with a
  // several-hundred-entry registry, doing this sequentially made opening
  // settings visibly slow (and, worse, made the rest of the page wait behind
  // it) for no benefit, since each entry's check is independent.
  const adoptedIds = await Promise.all(
    registryEntries.map(async (entry): Promise<string | null> => {
      const existing = trackedPlugins[entry.id];
      if (existing) {
        if (existing.name !== entry.name) {
          existing.name = entry.name;
        }
        return null;
      }
      const installedVersion = await readInstalledManifestVersion(adapter, entry.id);
      if (!installedVersion) return null;
      trackedPlugins[entry.id] = { repo: entry.repo, installedVersion, allowPrerelease: false, name: entry.name };
      return entry.id;
    })
  );
  return adoptedIds.filter((id): id is string => id !== null);
}

export async function removePlugin(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
  pluginId: string
): Promise<void> {
  await pluginManager.disablePlugin(pluginId);
  await adapter.rmdir(`.obsidian/plugins/${pluginId}`, true);
  // Keeps Obsidian's own manifest cache in sync with what we just deleted —
  // same reasoning as installPluginVersion's rescan.
  await pluginManager.loadManifests();
}

/**
 * Mirror image of adoptUntrackedInstalledPlugins: removes tracked entries
 * whose manifest.json can no longer be read from disk — e.g. removed via
 * Obsidian's own Community Plugins page, which has no knowledge of our
 * separate trackedPlugins data and so never updates it. Without this, a
 * plugin removed that way keeps showing as "installed" here indefinitely,
 * with whatever version was last cached. Mutates trackedPlugins in place
 * and returns the ids that were pruned.
 */
export async function pruneUninstalledTrackedPlugins(
  adapter: VaultAdapterLike,
  trackedPlugins: Record<string, TrackedPlugin>
): Promise<string[]> {
  const ids = Object.keys(trackedPlugins);
  const prunedIds = await Promise.all(
    ids.map(async (id): Promise<string | null> => {
      const stillExists = await adapter.exists(`.obsidian/plugins/${id}/manifest.json`);
      if (stillExists) return null;
      delete trackedPlugins[id];
      return id;
    })
  );
  return prunedIds.filter((id): id is string => id !== null);
}
