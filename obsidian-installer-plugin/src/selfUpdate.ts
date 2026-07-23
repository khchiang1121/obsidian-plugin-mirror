import { fetchVersions, type RegistryEntry, type VersionEntry } from './registry';
import { sortVersionsNewestFirst, selectUpdateCandidate, isNewerThanInstalled } from './versionCompare';
import type { FetchLike } from './obsidianFetch';

export interface SelfUpdateStatus {
  status: 'not-in-registry' | 'up-to-date' | 'update-available' | 'error';
  repo?: string;
  candidate?: VersionEntry;
  error?: string;
}

export function findSelfRegistryEntry(entries: RegistryEntry[], selfId: string): RegistryEntry | null {
  return entries.find((e) => e.id === selfId) ?? null;
}

/**
 * Checks whether a newer version of this plugin itself is available on the
 * mirror. Kept separate from checkForUpdates/adoptUntrackedInstalledPlugins
 * deliberately — this plugin never adopts or manages itself through the
 * generic tracked-plugin flow (see checkForUpdates' excludeIds), since that
 * flow's "Remove" action would delete this plugin's own running folder.
 * Always uses allowPrerelease: false — self-update stays conservative
 * regardless of what other plugins are configured to allow.
 */
export async function checkSelfUpdate(
  mirrorBaseUrl: string,
  entries: RegistryEntry[],
  selfId: string,
  installedVersion: string,
  fetchFn: FetchLike = fetch
): Promise<SelfUpdateStatus> {
  const entry = findSelfRegistryEntry(entries, selfId);
  if (!entry) return { status: 'not-in-registry' };

  try {
    const data = await fetchVersions(mirrorBaseUrl, entry.repo, fetchFn);
    const sorted = sortVersionsNewestFirst(data.versions);
    const candidate = selectUpdateCandidate(sorted, false);
    if (!candidate || !isNewerThanInstalled(candidate, installedVersion, sorted)) {
      return { status: 'up-to-date', repo: entry.repo };
    }
    return { status: 'update-available', repo: entry.repo, candidate };
  } catch (error) {
    return { status: 'error', repo: entry.repo, error: (error as Error).message };
  }
}
