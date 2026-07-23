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
    const input = [
      candidate('5.0.0', '2026-05-01T00:00:00Z'),
      candidate('4.0.0', '2026-04-01T00:00:00Z'),
      candidate('3.0.0', '2026-03-01T00:00:00Z'),
      candidate('2.0.0', '2026-02-01T00:00:00Z'),
      candidate('1.0.0', '2026-01-01T00:00:00Z'),
    ];
    expect(applyRetention(input, 2).map((r) => r.version)).toEqual(['5.0.0', '4.0.0']);
  });

  it('keeps everything when retain is "all"', () => {
    const input = [
      candidate('3.0.0', '2026-03-01T00:00:00Z'),
      candidate('2.0.0', '2026-02-01T00:00:00Z'),
      candidate('1.0.0', '2026-01-01T00:00:00Z'),
    ];
    expect(applyRetention(input, 'all').map((r) => r.version)).toEqual(['3.0.0', '2.0.0', '1.0.0']);
  });

  it('does not error when N exceeds the array length', () => {
    const input = [candidate('2.0.0', '2026-02-01T00:00:00Z'), candidate('1.0.0', '2026-01-01T00:00:00Z')];
    expect(applyRetention(input, 10).map((r) => r.version)).toEqual(['2.0.0', '1.0.0']);
  });

  it('is unaffected by minStableRetain when the window already satisfies it', () => {
    const input = [
      candidate('2.0.0', '2026-03-01T00:00:00Z', false),
      candidate('1.9.0-beta.1', '2026-02-15T00:00:00Z', true),
      candidate('1.5.0', '2026-01-15T00:00:00Z', false),
    ];
    const result = applyRetention(input, 2, 1);
    expect(result.map((r) => r.version)).toEqual(['2.0.0', '1.9.0-beta.1']);
  });

  it('reaches back beyond retain to satisfy an unmet minStableRetain floor', () => {
    const input = [
      candidate('2.0.0-beta.3', '2026-05-01T00:00:00Z', true),
      candidate('2.0.0-beta.2', '2026-04-01T00:00:00Z', true),
      candidate('2.0.0-beta.1', '2026-03-01T00:00:00Z', true),
      candidate('1.5.0', '2026-02-01T00:00:00Z', false),
      candidate('1.0.0', '2026-01-01T00:00:00Z', false),
    ];
    const result = applyRetention(input, 2, 1);
    expect(result.map((r) => r.version)).toEqual([
      '2.0.0-beta.3',
      '2.0.0-beta.2',
      '1.5.0',
    ]);
  });

  it('stops once the floor is met and does not pull in more stable versions than requested', () => {
    const input = [
      candidate('3.0.0-beta.1', '2026-04-01T00:00:00Z', true),
      candidate('2.0.0', '2026-03-01T00:00:00Z', false),
      candidate('1.5.0', '2026-02-01T00:00:00Z', false),
      candidate('1.0.0', '2026-01-01T00:00:00Z', false),
    ];
    const result = applyRetention(input, 1, 2);
    expect(result.map((r) => r.version)).toEqual(['3.0.0-beta.1', '2.0.0', '1.5.0']);
  });

  it('ignores minStableRetain when retain is "all"', () => {
    const input = [
      candidate('2.0.0-beta.1', '2026-02-01T00:00:00Z', true),
      candidate('1.0.0', '2026-01-01T00:00:00Z', false),
    ];
    const result = applyRetention(input, 'all', 5);
    expect(result.map((r) => r.version)).toEqual(['2.0.0-beta.1', '1.0.0']);
  });

  it('leaves the retained set as-is when there are not enough stable versions to satisfy the floor', () => {
    const input = [
      candidate('2.0.0-beta.2', '2026-02-01T00:00:00Z', true),
      candidate('2.0.0-beta.1', '2026-01-01T00:00:00Z', true),
    ];
    const result = applyRetention(input, 2, 5);
    expect(result.map((r) => r.version)).toEqual(['2.0.0-beta.2', '2.0.0-beta.1']);
  });

  it('defaults minStableRetain to 0, matching prior behavior', () => {
    const input = [
      candidate('2.0.0-beta.1', '2026-02-01T00:00:00Z', true),
      candidate('1.0.0', '2026-01-01T00:00:00Z', false),
    ];
    expect(applyRetention(input, 1)).toEqual([input[0]]);
  });
});
