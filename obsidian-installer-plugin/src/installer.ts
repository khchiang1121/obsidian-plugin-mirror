import type { FetchLike } from './obsidianFetch';
import type { RegistryEntry } from './registry';
import type { TrackedPlugin } from './settings';

export interface VaultAdapterLike {
  mkdir(path: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  read(path: string): Promise<string>;
}

export interface PluginManagerLike {
  enablePlugin(id: string): Promise<void>;
  disablePlugin(id: string): Promise<void>;
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
}
