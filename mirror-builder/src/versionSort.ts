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

export function applyRetention<T extends ReleaseCandidate>(
  sortedNewestFirst: T[],
  retain: number | 'all',
  minStableRetain = 0
): T[] {
  if (retain === 'all') return [...sortedNewestFirst];

  const window = sortedNewestFirst.slice(0, retain);
  const stableCount = window.filter((r) => !r.prerelease).length;
  const shortfall = minStableRetain - stableCount;
  if (shortfall <= 0) return window;

  const windowVersions = new Set(window.map((r) => r.version));
  const extra: T[] = [];
  for (const release of sortedNewestFirst.slice(retain)) {
    if (extra.length >= shortfall) break;
    if (!release.prerelease && !windowVersions.has(release.version)) {
      extra.push(release);
    }
  }

  return [...window, ...extra].sort(compareReleasesNewestFirst);
}
