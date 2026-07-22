import type { FetchLike } from './obsidianFetch';

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

export async function installPluginVersion(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
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

export async function removePlugin(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
  pluginId: string
): Promise<void> {
  await pluginManager.disablePlugin(pluginId);
  await adapter.rmdir(`.obsidian/plugins/${pluginId}`, true);
}
