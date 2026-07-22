import { fetchVersions, type VersionEntry } from './registry';
import { sortVersionsNewestFirst, selectUpdateCandidate, isNewerThanInstalled } from './versionCompare';
import { installPluginVersion, type VaultAdapterLike, type PluginManagerLike } from './installer';
import type { TrackedPlugin } from './settings';

export interface UpdateCheckResult {
  pluginId: string;
  status: 'up-to-date' | 'update-available' | 'error';
  candidate?: VersionEntry;
  error?: string;
}

export async function checkForUpdates(
  mirrorBaseUrl: string,
  trackedPlugins: Record<string, TrackedPlugin>,
  fetchFn: typeof fetch = fetch
): Promise<UpdateCheckResult[]> {
  const results: UpdateCheckResult[] = [];

  for (const [pluginId, tracked] of Object.entries(trackedPlugins)) {
    try {
      const data = await fetchVersions(mirrorBaseUrl, tracked.repo, fetchFn);
      const sorted = sortVersionsNewestFirst(data.versions);
      const candidate = selectUpdateCandidate(sorted, tracked.allowPrerelease);

      if (!candidate || !isNewerThanInstalled(candidate, tracked.installedVersion, sorted)) {
        results.push({ pluginId, status: 'up-to-date' });
        continue;
      }

      results.push({ pluginId, status: 'update-available', candidate });
    } catch (error) {
      results.push({ pluginId, status: 'error', error: (error as Error).message });
    }
  }

  return results;
}

export async function applyUpdate(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
  mirrorBaseUrl: string,
  pluginId: string,
  repo: string,
  candidate: VersionEntry,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  await installPluginVersion(
    adapter,
    pluginManager,
    mirrorBaseUrl,
    pluginId,
    { repo, version: candidate.version, files: candidate.files },
    fetchFn
  );
}
