import semver from 'semver';

export interface VersionCandidate {
  version: string;
  prerelease: boolean;
  publishedAt: string;
}

function parseSemver(tag: string): string | null {
  const coerced = semver.coerce(tag);
  if (!coerced) return null;
  return semver.valid(coerced) ? coerced.version : null;
}

export function compareVersionsNewestFirst(a: VersionCandidate, b: VersionCandidate): number {
  const aVer = parseSemver(a.version);
  const bVer = parseSemver(b.version);
  if (aVer && bVer) {
    return semver.compare(bVer, aVer);
  }
  return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
}

export function sortVersionsNewestFirst<T extends VersionCandidate>(versions: T[]): T[] {
  return [...versions].sort(compareVersionsNewestFirst);
}

export function selectUpdateCandidate<T extends VersionCandidate>(
  versions: T[],
  allowPrerelease: boolean
): T | null {
  const eligible = versions.filter((v) => allowPrerelease || !v.prerelease);
  if (eligible.length === 0) return null;
  return sortVersionsNewestFirst(eligible)[0];
}

export function isNewerThanInstalled(
  candidate: VersionCandidate,
  installedVersion: string,
  allVersions: VersionCandidate[]
): boolean {
  if (candidate.version === installedVersion) return false;
  const installedEntry = allVersions.find((v) => v.version === installedVersion);
  if (!installedEntry) return true;
  return compareVersionsNewestFirst(candidate, installedEntry) < 0;
}
