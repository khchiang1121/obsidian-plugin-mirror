import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { findSelfRegistryEntry, checkSelfUpdate } from '../src/selfUpdate';
import type { RegistryEntry } from '../src/registry';

const MIRROR = 'https://plugins.internal.example.test';

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: 'obsidian-mirror-installer',
    name: 'Mirror Installer',
    author: 'khchiang1121',
    description: 'desc',
    repo: 'khchiang1121/obsidian-plugin-mirror',
    latestVersion: '1.0.4',
    latestPrerelease: null,
    ...overrides,
  };
}

describe('findSelfRegistryEntry', () => {
  it('finds the entry matching the given id', () => {
    const entries = [entry({ id: 'other-plugin', repo: 'acme/other' }), entry()];
    expect(findSelfRegistryEntry(entries, 'obsidian-mirror-installer')).toEqual(entry());
  });

  it('returns null when no entry matches', () => {
    const entries = [entry({ id: 'other-plugin', repo: 'acme/other' })];
    expect(findSelfRegistryEntry(entries, 'obsidian-mirror-installer')).toBeNull();
  });
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function versionsHandler(repo: string, versions: unknown[]) {
  return http.get(`${MIRROR}/plugins/${repo}/versions.json`, () =>
    HttpResponse.json({ repo, latest: null, versions })
  );
}

describe('checkSelfUpdate', () => {
  it('returns not-in-registry when no entry matches the given id', async () => {
    const result = await checkSelfUpdate(MIRROR, [], 'obsidian-mirror-installer', '1.0.0');
    expect(result).toEqual({ status: 'not-in-registry' });
  });

  it('returns update-available when a newer version is mirrored', async () => {
    server.use(
      versionsHandler('khchiang1121/obsidian-plugin-mirror', [
        { version: '1.0.4', prerelease: false, publishedAt: '2026-07-23T00:00:00Z', files: ['manifest.json', 'main.js'] },
        { version: '1.0.0', prerelease: false, publishedAt: '2026-07-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const result = await checkSelfUpdate(MIRROR, [entry()], 'obsidian-mirror-installer', '1.0.0');
    expect(result.status).toBe('update-available');
    expect(result.repo).toBe('khchiang1121/obsidian-plugin-mirror');
    expect(result.candidate?.version).toBe('1.0.4');
  });

  it('returns up-to-date when already on the newest version', async () => {
    server.use(
      versionsHandler('khchiang1121/obsidian-plugin-mirror', [
        { version: '1.0.4', prerelease: false, publishedAt: '2026-07-23T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const result = await checkSelfUpdate(MIRROR, [entry()], 'obsidian-mirror-installer', '1.0.4');
    expect(result).toEqual({ status: 'up-to-date', repo: 'khchiang1121/obsidian-plugin-mirror' });
  });

  it('returns error when fetching versions.json fails', async () => {
    server.use(
      http.get(`${MIRROR}/plugins/khchiang1121/obsidian-plugin-mirror/versions.json`, () =>
        HttpResponse.json({}, { status: 500 })
      )
    );
    const result = await checkSelfUpdate(MIRROR, [entry()], 'obsidian-mirror-installer', '1.0.0');
    expect(result.status).toBe('error');
    expect(result.repo).toBe('khchiang1121/obsidian-plugin-mirror');
  });
});
