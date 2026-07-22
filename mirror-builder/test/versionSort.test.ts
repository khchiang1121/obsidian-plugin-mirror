import { describe, it, expect } from 'vitest';
import { sortReleasesNewestFirst, applyRetention, type ReleaseCandidate } from '../src/versionSort.js';

function candidate(version: string, publishedAt: string, prerelease = false): ReleaseCandidate {
  return { version, publishedAt, prerelease };
}

describe('sortReleasesNewestFirst', () => {
  it('sorts valid semver tags newest-first by semver value', () => {
    const input = [
      candidate('1.0.0', '2026-01-01T00:00:00Z'),
      candidate('2.1.0', '2026-02-01T00:00:00Z'),
      candidate('1.5.0', '2026-01-15T00:00:00Z'),
    ];
    const sorted = sortReleasesNewestFirst(input);
    expect(sorted.map((r) => r.version)).toEqual(['2.1.0', '1.5.0', '1.0.0']);
  });

  it('falls back to publishedAt when tags are not valid semver', () => {
    const input = [
      candidate('release-a', '2026-01-01T00:00:00Z'),
      candidate('release-b', '2026-03-01T00:00:00Z'),
      candidate('release-c', '2026-02-01T00:00:00Z'),
    ];
    const sorted = sortReleasesNewestFirst(input);
    expect(sorted.map((r) => r.version)).toEqual(['release-b', 'release-c', 'release-a']);
  });

  it('falls back to publishedAt when only one of a pair is valid semver', () => {
    const input = [
      candidate('1.0.0', '2026-01-01T00:00:00Z'),
      candidate('nightly-build', '2026-06-01T00:00:00Z'),
    ];
    const sorted = sortReleasesNewestFirst(input);
    expect(sorted.map((r) => r.version)).toEqual(['nightly-build', '1.0.0']);
  });

  it('does not mutate the input array', () => {
    const input = [candidate('1.0.0', '2026-01-01T00:00:00Z'), candidate('2.0.0', '2026-02-01T00:00:00Z')];
    const original = [...input];
    sortReleasesNewestFirst(input);
    expect(input).toEqual(original);
  });
});

describe('applyRetention', () => {
  it('keeps only the first N entries for a numeric retain', () => {
    const input = [1, 2, 3, 4, 5];
    expect(applyRetention(input, 2)).toEqual([1, 2]);
  });

  it('keeps everything when retain is "all"', () => {
    const input = [1, 2, 3];
    expect(applyRetention(input, 'all')).toEqual([1, 2, 3]);
  });

  it('does not error when N exceeds the array length', () => {
    const input = [1, 2];
    expect(applyRetention(input, 10)).toEqual([1, 2]);
  });
});
