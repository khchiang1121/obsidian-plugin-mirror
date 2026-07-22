import semver from 'semver';

export interface ReleaseCandidate {
  version: string;
  prerelease: boolean;
  publishedAt: string;
}

function parseSemver(tag: string): string | null {
  const coerced = semver.coerce(tag);
  if (!coerced) return null;
  return semver.valid(coerced) ? coerced.version : null;
}

export function compareReleasesNewestFirst(a: ReleaseCandidate, b: ReleaseCandidate): number {
  const aVer = parseSemver(a.version);
  const bVer = parseSemver(b.version);
  if (aVer && bVer) {
    return semver.compare(bVer, aVer);
  }
  return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
}

export function sortReleasesNewestFirst<T extends ReleaseCandidate>(releases: T[]): T[] {
  return [...releases].sort(compareReleasesNewestFirst);
}

export function applyRetention<T>(sortedNewestFirst: T[], retain: number | 'all'): T[] {
  if (retain === 'all') return [...sortedNewestFirst];
  return sortedNewestFirst.slice(0, retain);
}
