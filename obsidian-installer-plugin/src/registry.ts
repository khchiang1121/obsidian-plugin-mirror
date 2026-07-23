import type { FetchLike } from './obsidianFetch';

export interface RegistryEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  latestVersion: string | null;
  latestPrerelease: string | null;
}

export interface RegistryIndex {
  generatedAt: string;
  plugins: RegistryEntry[];
}

export interface VersionEntry {
  version: string;
  prerelease: boolean;
  publishedAt: string;
  files: string[];
}

export interface VersionsData {
  repo: string;
  latest: string | null;
  versions: VersionEntry[];
}

export class RegistryError extends Error {}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Appends a unique query param so Obsidian's requestUrl (backed by
 * Electron's Chromium network stack) can't serve a stale cached response
 * for what would otherwise be a plain, unchanging URL — index.json and
 * versions.json are rewritten in place on every mirror rebuild, so a cached
 * hit here means silently-stale data with no error to signal it.
 */
export function cacheBust(url: string): string {
  return `${url}?_=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function fetchIndex(mirrorBaseUrl: string, fetchFn: FetchLike = fetch): Promise<RegistryIndex> {
  const url = `${trimTrailingSlash(mirrorBaseUrl)}/index.json`;
  const response = await fetchFn(cacheBust(url));
  if (!response.ok) {
    throw new RegistryError(`Failed to fetch registry index from ${url}: ${response.status}`);
  }
  return (await response.json()) as RegistryIndex;
}

export async function fetchVersions(
  mirrorBaseUrl: string,
  repo: string,
  fetchFn: FetchLike = fetch
): Promise<VersionsData> {
  const url = `${trimTrailingSlash(mirrorBaseUrl)}/plugins/${repo}/versions.json`;
  const response = await fetchFn(cacheBust(url));
  if (!response.ok) {
    throw new RegistryError(`Failed to fetch versions.json for ${repo} from ${url}: ${response.status}`);
  }
  return (await response.json()) as VersionsData;
}
