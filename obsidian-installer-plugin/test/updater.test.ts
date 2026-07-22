import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { checkForUpdates, applyUpdate } from '../src/updater';
import type { VaultAdapterLike, PluginManagerLike } from '../src/installer';
import type { TrackedPlugin } from '../src/settings';

const server = setupServer();
const MIRROR = 'https://plugins.internal.example.test';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function versionsHandler(repo: string, versions: unknown[]) {
  return http.get(`${MIRROR}/plugins/${repo}/versions.json`, () =>
    HttpResponse.json({ repo, latest: null, versions })
  );
}

class FakeAdapter implements VaultAdapterLike {
  writes: Array<{ path: string; data: string }> = [];

  constructor(private manifestVersions: Record<string, string> = {}) {}

  async mkdir(): Promise<void> {}
  async write(path: string, data: string): Promise<void> {
    this.writes.push({ path, data });
  }
  async rmdir(): Promise<void> {}
  async read(path: string): Promise<string> {
    const match = /\.obsidian\/plugins\/([^/]+)\/manifest\.json$/.exec(path);
    const pluginId = match?.[1];
    if (pluginId && this.manifestVersions[pluginId] !== undefined) {
      return JSON.stringify({ version: this.manifestVersions[pluginId] });
    }
    throw new Error('ENOENT: no such file');
  }
}

class FakePluginManager implements PluginManagerLike {
  enabled: string[] = [];
  async enablePlugin(id: string): Promise<void> {
    this.enabled.push(id);
  }
  async disablePlugin(): Promise<void> {}
}

describe('checkForUpdates', () => {
  it('reports update-available when a newer stable version exists', async () => {
    server.use(
      versionsHandler('acme/plugin-one', [
        { version: '2.0.0', prerelease: false, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
        { version: '1.0.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const tracked: Record<string, TrackedPlugin> = {
      'plugin-one': { repo: 'acme/plugin-one', installedVersion: '1.0.0', allowPrerelease: false },
    };
    const results = await checkForUpdates(MIRROR, tracked, new FakeAdapter());
    expect(results).toEqual([
      {
        pluginId: 'plugin-one',
        status: 'update-available',
        candidate: { version: '2.0.0', prerelease: false, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      },
    ]);
  });

  it('reports up-to-date when already on the newest eligible version', async () => {
    server.use(
      versionsHandler('acme/plugin-one', [
        { version: '1.0.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const tracked: Record<string, TrackedPlugin> = {
      'plugin-one': { repo: 'acme/plugin-one', installedVersion: '1.0.0', allowPrerelease: false },
    };
    const results = await checkForUpdates(MIRROR, tracked, new FakeAdapter());
    expect(results).toEqual([{ pluginId: 'plugin-one', status: 'up-to-date' }]);
  });

  it('excludes prerelease candidates when allowPrerelease is false for that plugin', async () => {
    server.use(
      versionsHandler('acme/plugin-one', [
        { version: '2.0.0-beta.1', prerelease: true, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
        { version: '1.0.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const tracked: Record<string, TrackedPlugin> = {
      'plugin-one': { repo: 'acme/plugin-one', installedVersion: '1.0.0', allowPrerelease: false },
    };
    const results = await checkForUpdates(MIRROR, tracked, new FakeAdapter());
    expect(results).toEqual([{ pluginId: 'plugin-one', status: 'up-to-date' }]);
  });

  it('includes prerelease candidates when allowPrerelease is true for that plugin', async () => {
    server.use(
      versionsHandler('acme/plugin-one', [
        { version: '2.0.0-beta.1', prerelease: true, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
        { version: '1.0.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const tracked: Record<string, TrackedPlugin> = {
      'plugin-one': { repo: 'acme/plugin-one', installedVersion: '1.0.0', allowPrerelease: true },
    };
    const results = await checkForUpdates(MIRROR, tracked, new FakeAdapter());
    expect(results[0].status).toBe('update-available');
    expect(results[0].candidate?.version).toBe('2.0.0-beta.1');
  });

  it('isolates a per-plugin fetch failure without affecting other plugins', async () => {
    server.use(
      versionsHandler('acme/plugin-good', [
        { version: '2.0.0', prerelease: false, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ]),
      http.get(`${MIRROR}/plugins/acme/plugin-bad/versions.json`, () => HttpResponse.json({}, { status: 404 }))
    );
    const tracked: Record<string, TrackedPlugin> = {
      'plugin-good': { repo: 'acme/plugin-good', installedVersion: '1.0.0', allowPrerelease: false },
      'plugin-bad': { repo: 'acme/plugin-bad', installedVersion: '1.0.0', allowPrerelease: false },
    };
    const results = await checkForUpdates(MIRROR, tracked, new FakeAdapter());
    const good = results.find((r) => r.pluginId === 'plugin-good');
    const bad = results.find((r) => r.pluginId === 'plugin-bad');
    expect(good?.status).toBe('update-available');
    expect(bad?.status).toBe('error');
  });

  it('treats a pruned installed version as an update opportunity', async () => {
    server.use(
      versionsHandler('acme/plugin-one', [
        { version: '2.0.0', prerelease: false, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const tracked: Record<string, TrackedPlugin> = {
      'plugin-one': { repo: 'acme/plugin-one', installedVersion: '0.5.0', allowPrerelease: false },
    };
    const results = await checkForUpdates(MIRROR, tracked, new FakeAdapter());
    expect(results[0].status).toBe('update-available');
  });

  it('uses the real on-disk manifest version instead of stale stored bookkeeping', async () => {
    // Simulates Obsidian's own built-in updater having bumped the plugin to
    // 2.0.0 directly on disk, without going through our install/update code —
    // our stored installedVersion is still the stale '1.0.0'.
    server.use(
      versionsHandler('acme/plugin-one', [
        { version: '2.0.0', prerelease: false, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const tracked: TrackedPlugin = { repo: 'acme/plugin-one', installedVersion: '1.0.0', allowPrerelease: false };
    const trackedPlugins: Record<string, TrackedPlugin> = { 'plugin-one': tracked };
    const adapter = new FakeAdapter({ 'plugin-one': '2.0.0' });

    const results = await checkForUpdates(MIRROR, trackedPlugins, adapter);

    expect(results).toEqual([{ pluginId: 'plugin-one', status: 'up-to-date' }]);
    expect(tracked.installedVersion).toBe('2.0.0');
  });

  it('still reports an update when the real on-disk version is older than the newest mirrored one', async () => {
    server.use(
      versionsHandler('acme/plugin-one', [
        { version: '3.0.0', prerelease: false, publishedAt: '2026-04-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const tracked: TrackedPlugin = { repo: 'acme/plugin-one', installedVersion: '1.0.0', allowPrerelease: false };
    const trackedPlugins: Record<string, TrackedPlugin> = { 'plugin-one': tracked };
    const adapter = new FakeAdapter({ 'plugin-one': '2.0.0' });

    const results = await checkForUpdates(MIRROR, trackedPlugins, adapter);

    expect(results[0].status).toBe('update-available');
    expect(results[0].candidate?.version).toBe('3.0.0');
    expect(tracked.installedVersion).toBe('2.0.0');
  });

  it('falls back to the stored installedVersion when the manifest cannot be read', async () => {
    server.use(
      versionsHandler('acme/plugin-one', [
        { version: '1.0.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const tracked: TrackedPlugin = { repo: 'acme/plugin-one', installedVersion: '1.0.0', allowPrerelease: false };
    const trackedPlugins: Record<string, TrackedPlugin> = { 'plugin-one': tracked };

    const results = await checkForUpdates(MIRROR, trackedPlugins, new FakeAdapter());

    expect(results).toEqual([{ pluginId: 'plugin-one', status: 'up-to-date' }]);
    expect(tracked.installedVersion).toBe('1.0.0');
  });
});

describe('applyUpdate', () => {
  it('downloads and installs the candidate version', async () => {
    const adapter = new FakeAdapter();
    const pluginManager = new FakePluginManager();
    const fetchFn = (async () => new Response('content', { status: 200 })) as typeof fetch;

    await applyUpdate(
      adapter,
      pluginManager,
      MIRROR,
      'plugin-one',
      'acme/plugin-one',
      { version: '2.0.0', prerelease: false, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      fetchFn
    );

    expect(adapter.writes.map((w) => w.path)).toEqual([
      '.obsidian/plugins/plugin-one/manifest.json',
      '.obsidian/plugins/plugin-one/main.js',
    ]);
    expect(pluginManager.enabled).toEqual(['plugin-one']);
  });
});
