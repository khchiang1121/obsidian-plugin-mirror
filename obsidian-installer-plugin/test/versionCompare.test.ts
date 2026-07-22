import { describe, it, expect } from 'vitest';
import {
  sortVersionsNewestFirst,
  selectUpdateCandidate,
  isNewerThanInstalled,
  type VersionCandidate,
} from '../src/versionCompare';

function candidate(version: string, publishedAt: string, prerelease = false): VersionCandidate {
  return { version, publishedAt, prerelease };
}

describe('sortVersionsNewestFirst', () => {
  it('sorts valid semver tags newest-first by semver value', () => {
    const input = [candidate('1.0.0', '2026-01-01T00:00:00Z'), candidate('2.1.0', '2026-02-01T00:00:00Z')];
    expect(sortVersionsNewestFirst(input).map((v) => v.version)).toEqual(['2.1.0', '1.0.0']);
  });

  it('falls back to publishedAt when tags are not valid semver', () => {
    const input = [candidate('release-a', '2026-01-01T00:00:00Z'), candidate('release-b', '2026-03-01T00:00:00Z')];
    expect(sortVersionsNewestFirst(input).map((v) => v.version)).toEqual(['release-b', 'release-a']);
  });
});

describe('selectUpdateCandidate', () => {
  it('excludes prereleases when allowPrerelease is false', () => {
    const input = [
      candidate('2.0.0-beta.1', '2026-03-01T00:00:00Z', true),
      candidate('1.5.0', '2026-02-01T00:00:00Z', false),
    ];
    expect(selectUpdateCandidate(input, false)?.version).toBe('1.5.0');
  });

  it('includes prereleases when allowPrerelease is true, picking the newest overall', () => {
    const input = [
      candidate('2.0.0-beta.1', '2026-03-01T00:00:00Z', true),
      candidate('1.5.0', '2026-02-01T00:00:00Z', false),
    ];
    expect(selectUpdateCandidate(input, true)?.version).toBe('2.0.0-beta.1');
  });

  it('returns null when there are no eligible versions', () => {
    const input = [candidate('2.0.0-beta.1', '2026-03-01T00:00:00Z', true)];
    expect(selectUpdateCandidate(input, false)).toBeNull();
  });
});

describe('isNewerThanInstalled', () => {
  const all = [
    candidate('2.0.0', '2026-03-01T00:00:00Z'),
    candidate('1.5.0', '2026-02-01T00:00:00Z'),
    candidate('1.0.0', '2026-01-01T00:00:00Z'),
  ];

  it('is true when the candidate is newer than the installed version', () => {
    expect(isNewerThanInstalled(all[0], '1.5.0', all)).toBe(true);
  });

  it('is false when the candidate is the same as the installed version', () => {
    expect(isNewerThanInstalled(all[1], '1.5.0', all)).toBe(false);
  });

  it('is false when the candidate is older than the installed version', () => {
    expect(isNewerThanInstalled(all[2], '1.5.0', all)).toBe(false);
  });

  it('is true when the installed version is no longer in the list (pruned upstream)', () => {
    expect(isNewerThanInstalled(all[0], '0.9.0', all)).toBe(true);
  });
});
