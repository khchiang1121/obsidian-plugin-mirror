import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, mergeIndexEntry, readExistingIndex, run } from '../src/updateOne.js';
import type { IndexJsonEntry } from '../src/writer.js';

describe('parseArgs', () => {
  it('applies defaults when no flags are given', () => {
    const options = parseArgs([]);
    expect(options).toMatchObject({ repo: '', outDir: './dist', retain: 5, minStableRetain: 0 });
  });

  it('parses --repo, --out, --retain, and --min-stable-retain', () => {
    const options = parseArgs([
      '--repo',
      'acme/plugin-one',
      '--out',
      './build',
      '--retain',
      '10',
      '--min-stable-retain',
      '3',
    ]);
    expect(options.repo).toBe('acme/plugin-one');
    expect(options.outDir).toBe('./build');
    expect(options.retain).toBe(10);
    expect(options.minStableRetain).toBe(3);
  });

  it('accepts --retain all', () => {
    const options = parseArgs(['--retain', 'all']);
    expect(options.retain).toBe('all');
  });
});

function entry(overrides: Partial<IndexJsonEntry> = {}): IndexJsonEntry {
  return {
    id: 'plugin-one',
    name: 'Plugin One',
    author: 'acme',
    description: 'desc',
    repo: 'acme/plugin-one',
    latestVersion: '1.0.0',
    latestPrerelease: null,
    ...overrides,
  };
}

describe('mergeIndexEntry', () => {
  it('appends a new entry when the repo is not already present', () => {
    const existing = [entry({ repo: 'acme/other', id: 'other' })];
    const result = mergeIndexEntry(existing, 'acme/plugin-one', entry());
    expect(result).toEqual([entry({ repo: 'acme/other', id: 'other' }), entry()]);
  });

  it('replaces the existing entry in place for a matching repo, leaving other entries untouched', () => {
    const existing = [entry({ repo: 'acme/other', id: 'other' }), entry({ latestVersion: '1.0.0' })];
    const result = mergeIndexEntry(existing, 'acme/plugin-one', entry({ latestVersion: '2.0.0' }));
    expect(result).toEqual([entry({ repo: 'acme/other', id: 'other' }), entry({ latestVersion: '2.0.0' })]);
  });

  it('matches the repo case-insensitively', () => {
    const existing = [entry({ repo: 'Acme/Plugin-One' })];
    const result = mergeIndexEntry(existing, 'acme/plugin-one', entry({ latestVersion: '2.0.0' }));
    expect(result).toEqual([entry({ latestVersion: '2.0.0' })]);
  });

  it('removes the entry for the repo when updated is undefined, without touching others', () => {
    const existing = [entry({ repo: 'acme/other', id: 'other' }), entry()];
    const result = mergeIndexEntry(existing, 'acme/plugin-one', undefined);
    expect(result).toEqual([entry({ repo: 'acme/other', id: 'other' })]);
  });
});

describe('readExistingIndex', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mirror-builder-update-one-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty array when index.json does not exist yet', () => {
    expect(readExistingIndex(tempDir)).toEqual([]);
  });

  it('returns the plugins array from an existing index.json', () => {
    writeFileSync(join(tempDir, 'index.json'), JSON.stringify({ generatedAt: '2026-01-01T00:00:00Z', plugins: [entry()] }));
    expect(readExistingIndex(tempDir)).toEqual([entry()]);
  });

  it('returns an empty array when index.json is malformed', () => {
    writeFileSync(join(tempDir, 'index.json'), 'not json');
    expect(readExistingIndex(tempDir)).toEqual([]);
  });
});

const server = setupServer();
let tempDir: string;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mirror-builder-update-one-e2e-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function manifestAsset(id: string, version: string) {
  return JSON.stringify({ id, name: id, version, author: 'Acme', description: `${id} description` });
}

function registerAssetHandlers(id: string) {
  server.use(
    http.get('https://assets.example.test/:version/manifest.json', ({ params }) =>
      HttpResponse.text(manifestAsset(id, String(params.version)))
    ),
    http.get('https://assets.example.test/:version/main.js', () => HttpResponse.text('console.log("main");'))
  );
}

function releasesResponse(versions: Array<{ tag: string; prerelease: boolean }>) {
  return versions.map(({ tag, prerelease }) => ({
    tag_name: tag,
    prerelease,
    published_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    assets: [
      { name: 'manifest.json', browser_download_url: `https://assets.example.test/${tag}/manifest.json` },
      { name: 'main.js', browser_download_url: `https://assets.example.test/${tag}/main.js` },
    ],
  }));
}

describe('run', () => {
  it('updates only the target repo, leaving other existing index.json entries untouched', async () => {
    // Seed an existing dist/ from a prior full mirror-builder run, as if
    // this ran independently afterwards.
    writeFileSync(
      join(tempDir, 'index.json'),
      JSON.stringify({
        generatedAt: '2026-01-01T00:00:00Z',
        plugins: [entry({ repo: 'other/plugin', id: 'other-plugin', name: 'Other Plugin' })],
      })
    );

    registerAssetHandlers('acme-plugin');
    server.use(
      http.get('https://api.github.com/repos/acme/plugin-one/releases', () =>
        HttpResponse.json(releasesResponse([{ tag: '1.0.0', prerelease: false }]))
      )
    );

    const exitCode = await run({ repo: 'acme/plugin-one', outDir: tempDir, retain: 5, minStableRetain: 0 });

    expect(exitCode).toBe(0);
    const index = JSON.parse(readFileSync(join(tempDir, 'index.json'), 'utf-8'));
    expect(index.plugins).toHaveLength(2);
    expect(index.plugins.find((p: IndexJsonEntry) => p.repo === 'other/plugin')).toBeTruthy();
    const updated = index.plugins.find((p: IndexJsonEntry) => p.repo === 'acme/plugin-one');
    expect(updated.latestVersion).toBe('1.0.0');

    // The other plugin's already-downloaded files must be left alone —
    // nothing in this run should have touched them.
    expect(existsSync(join(tempDir, 'plugins', 'other', 'plugin'))).toBe(false); // never existed, never created
    expect(existsSync(join(tempDir, 'plugins', 'acme', 'plugin-one', '1.0.0', 'manifest.json'))).toBe(true);
  });

  it('returns a non-zero exit code when --repo is missing', async () => {
    const exitCode = await run({ repo: '', outDir: tempDir, retain: 5, minStableRetain: 0 });
    expect(exitCode).toBe(1);
  });

  it('returns a non-zero exit code and leaves the existing index.json untouched when the repo has no valid release', async () => {
    writeFileSync(
      join(tempDir, 'index.json'),
      JSON.stringify({ generatedAt: '2026-01-01T00:00:00Z', plugins: [entry({ repo: 'other/plugin', id: 'other-plugin' })] })
    );
    server.use(
      http.get('https://api.github.com/repos/acme/broken/releases', () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 })
      )
    );

    const exitCode = await run({ repo: 'acme/broken', outDir: tempDir, retain: 5, minStableRetain: 0 });

    expect(exitCode).toBe(1);
    const index = JSON.parse(readFileSync(join(tempDir, 'index.json'), 'utf-8'));
    expect(index.plugins).toEqual([entry({ repo: 'other/plugin', id: 'other-plugin' })]);
  });
});
