import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateRelease,
  isVersionDirComplete,
  ensureVersionAssets,
  pruneStaleVersionDirs,
  type ValidatedVersion,
} from '../src/assets.js';
import type { FetchedRelease } from '../src/github.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mirror-builder-assets-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function release(assetNames: string[]): FetchedRelease {
  return {
    tagName: '1.0.0',
    prerelease: false,
    publishedAt: '2026-01-01T00:00:00Z',
    assets: assetNames.map((name) => ({ name, downloadUrl: `https://assets.example.test/${name}` })),
  };
}

describe('validateRelease', () => {
  it('returns null when main.js is missing', () => {
    expect(validateRelease(release(['manifest.json']))).toBeNull();
  });

  it('returns null when manifest.json is missing', () => {
    expect(validateRelease(release(['main.js']))).toBeNull();
  });

  it('includes optional files only when present, required-first', () => {
    const validated = validateRelease(release(['manifest.json', 'main.js', 'styles.css']));
    expect(validated?.files).toEqual(['manifest.json', 'main.js', 'styles.css']);
  });

  it('excludes optional files that are absent', () => {
    const validated = validateRelease(release(['manifest.json', 'main.js']));
    expect(validated?.files).toEqual(['manifest.json', 'main.js']);
  });
});

describe('isVersionDirComplete', () => {
  it('is false when the directory does not exist', () => {
    expect(isVersionDirComplete(join(tempDir, 'missing'), ['manifest.json'])).toBe(false);
  });

  it('is false when a required file is missing', () => {
    const dir = join(tempDir, 'v1');
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), '{}');
    expect(isVersionDirComplete(dir, ['manifest.json', 'main.js'])).toBe(false);
  });

  it('is true when all expected files are present', () => {
    const dir = join(tempDir, 'v1');
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), '{}');
    writeFileSync(join(dir, 'main.js'), '');
    expect(isVersionDirComplete(dir, ['manifest.json', 'main.js'])).toBe(true);
  });
});

describe('ensureVersionAssets', () => {
  const version: ValidatedVersion = {
    version: '1.0.0',
    prerelease: false,
    publishedAt: '2026-01-01T00:00:00Z',
    files: ['manifest.json', 'main.js'],
    assetUrls: {
      'manifest.json': 'https://assets.example.test/manifest.json',
      'main.js': 'https://assets.example.test/main.js',
    },
  };

  it('downloads assets when the version directory is missing', async () => {
    const calls: string[] = [];
    const result = await ensureVersionAssets(tempDir, version, undefined, async (url, dest) => {
      calls.push(url);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, 'stub');
    });
    expect(result).toBe('downloaded');
    expect(calls).toHaveLength(2);
    expect(existsSync(join(tempDir, '1.0.0', 'manifest.json'))).toBe(true);
  });

  it('skips downloading when the version directory is already complete', async () => {
    const dir = join(tempDir, '1.0.0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), 'existing');
    writeFileSync(join(dir, 'main.js'), 'existing');

    const calls: string[] = [];
    const result = await ensureVersionAssets(tempDir, version, undefined, async (url) => {
      calls.push(url);
    });
    expect(result).toBe('skipped');
    expect(calls).toHaveLength(0);
  });
});

describe('pruneStaleVersionDirs', () => {
  it('removes version directories not in the retained set', () => {
    const pluginDir = join(tempDir, 'plugin');
    mkdirSync(join(pluginDir, '1.0.0'), { recursive: true });
    mkdirSync(join(pluginDir, '2.0.0'), { recursive: true });
    mkdirSync(join(pluginDir, '3.0.0'), { recursive: true });

    const removed = pruneStaleVersionDirs(pluginDir, ['3.0.0']);

    expect(removed.sort()).toEqual(['1.0.0', '2.0.0']);
    expect(readdirSync(pluginDir)).toEqual(['3.0.0']);
  });

  it('returns an empty array when the plugin directory does not exist yet', () => {
    expect(pruneStaleVersionDirs(join(tempDir, 'does-not-exist'), ['1.0.0'])).toEqual([]);
  });
});
