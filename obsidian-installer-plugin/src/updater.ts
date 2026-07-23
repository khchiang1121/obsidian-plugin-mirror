import { fetchIndex, fetchVersions, type VersionEntry } from './registry';
import { sortVersionsNewestFirst, selectUpdateCandidate, isNewerThanInstalled } from './versionCompare';
import {
  installPluginVersion,
  readInstalledManifestVersion,
  adoptUntrackedInstalledPlugins,
  type VaultAdapterLike,
  type PluginManagerLike,
} from './installer';
import type { TrackedPlugin } from './settings';
import type { FetchLike } from './obsidianFetch';

export interface UpdateCheckResult {
  pluginId: string;
  status: 'up-to-date' | 'update-available' | 'error';
  candidate?: VersionEntry;
  error?: string;
}

export async function checkForUpdates(
  mirrorBaseUrl: string,
  trackedPlugins: Record<string, TrackedPlugin>,
  adapter: VaultAdapterLike,
  fetchFn: FetchLike = fetch
): Promise<UpdateCheckResult[]> {
  try {
    // Pick up plugins installed by other means (Obsidian's built-in browser,
    // BRAT, a manual copy) before checking updates, so a fresh install found
    // this way gets its first update check in the same pass — not just the
    // next time the settings tab happens to be opened.
    const index = await fetchIndex(mirrorBaseUrl, fetchFn);
    await adoptUntrackedInstalledPlugins(adapter, trackedPlugins, index.plugins);
  } catch {
    // Registry unreachable/unparseable — proceed with whatever's already
    // tracked; the per-plugin fetchVersions calls below still run and
    // surface their own errors individually.
  }

  // Checked concurrently rather than one at a time — with a large tracked
  // set this was a long chain of sequential network round-trips for no
  // reason, since each plugin's check is independent of the others.
  const results = await Promise.all(
    Object.entries(trackedPlugins).map(async ([pluginId, tracked]): Promise<UpdateCheckResult> => {
      try {
        // Something other than this plugin (e.g. Obsidian's own built-in
        // Community Plugins updater) may have changed the installed files
        // directly, without going through our install/update code — so our
        // cached installedVersion can drift from what's actually on disk.
        // Re-read the real manifest.json as ground truth and self-heal the
        // cache whenever it disagrees.
        const actualVersion = await readInstalledManifestVersion(adapter, pluginId);
        if (actualVersion && actualVersion !== tracked.installedVersion) {
          tracked.installedVersion = actualVersion;
        }

        const data = await fetchVersions(mirrorBaseUrl, tracked.repo, fetchFn);
        const sorted = sortVersionsNewestFirst(data.versions);
        const candidate = selectUpdateCandidate(sorted, tracked.allowPrerelease);

        if (!candidate || !isNewerThanInstalled(candidate, tracked.installedVersion, sorted)) {
          return { pluginId, status: 'up-to-date' };
        }

        return { pluginId, status: 'update-available', candidate };
      } catch (error) {
        return { pluginId, status: 'error', error: (error as Error).message };
      }
    })
  );

  return results;
}

export async function applyUpdate(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
  mirrorBaseUrl: string,
  pluginId: string,
  repo: string,
  candidate: VersionEntry,
  fetchFn: FetchLike = fetch
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
