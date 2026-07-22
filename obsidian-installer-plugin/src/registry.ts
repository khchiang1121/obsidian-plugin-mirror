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

export async function fetchIndex(mirrorBaseUrl: string, fetchFn: typeof fetch = fetch): Promise<RegistryIndex> {
  const url = `${trimTrailingSlash(mirrorBaseUrl)}/index.json`;
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new RegistryError(`Failed to fetch registry index from ${url}: ${response.status}`);
  }
  return (await response.json()) as RegistryIndex;
}

export async function fetchVersions(
  mirrorBaseUrl: string,
  repo: string,
  fetchFn: typeof fetch = fetch
): Promise<VersionsData> {
  const url = `${trimTrailingSlash(mirrorBaseUrl)}/plugins/${repo}/versions.json`;
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new RegistryError(`Failed to fetch versions.json for ${repo} from ${url}: ${response.status}`);
  }
  return (await response.json()) as VersionsData;
}
