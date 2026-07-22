import type { FetchLike } from './obsidianFetch';

export interface VaultAdapterLike {
  mkdir(path: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
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

export async function removePlugin(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
  pluginId: string
): Promise<void> {
  await pluginManager.disablePlugin(pluginId);
  await adapter.rmdir(`.obsidian/plugins/${pluginId}`, true);
}
