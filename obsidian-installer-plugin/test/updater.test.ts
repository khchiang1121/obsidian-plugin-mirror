import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { checkForUpdates, applyUpdate } from '../src/updater';
import type { VaultAdapterLike, PluginManagerLike } from '../src/installer';
import type { TrackedPlugin } from '../src/settings';

const MIRROR = 'https://plugins.internal.example.test';

// Default empty registry so tests that don't care about adoption don't need
// to mock /index.json themselves; individual tests override with server.use().
const server = setupServer(
  http.get(`${MIRROR}/index.json`, () => HttpResponse.json({ generatedAt: '2026-01-01T00:00:00Z', plugins: [] }))
);

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

  // removedIds is a separate, explicit opt-in (rather than exists()
  // defaulting to "whatever's in manifestVersions") so every existing test
  // that never intended to exercise pruneUninstalledTrackedPlugins keeps
  // behaving as if every tracked plugin is still installed, regardless of
  // whether it bothered to also register a manifestVersions entry.
  constructor(
    private manifestVersions: Record<string, string> = {},
    private removedIds: string[] = []
  ) {}

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
  async exists(path: string): Promise<boolean> {
    const match = /\.obsidian\/plugins\/([^/]+)\/manifest\.json$/.exec(path);
    const pluginId = match?.[1];
    return pluginId ? !this.removedIds.includes(pluginId) : true;
  }
}

class FakePluginManager implements PluginManagerLike {
  enabled: string[] = [];
  async enablePlugin(id: string): Promise<void> {
    this.enabled.push(id);
  }
  async disablePlugin(): Promise<void> {}
  async loadManifests(): Promise<void> {}
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

  it('adopts an untracked but on-disk plugin found in the registry and checks it for updates in the same pass', async () => {
    server.use(
      http.get(`${MIRROR}/index.json`, () =>
        HttpResponse.json({
          generatedAt: '2026-01-01T00:00:00Z',
          plugins: [
            {
              id: 'plugin-one',
              name: 'Plugin One',
              author: 'acme',
              description: 'desc',
              repo: 'acme/plugin-one',
              latestVersion: '2.0.0',
              latestPrerelease: null,
            },
          ],
        })
      ),
      versionsHandler('acme/plugin-one', [
        { version: '2.0.0', prerelease: false, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
        { version: '1.0.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ])
    );
    const trackedPlugins: Record<string, TrackedPlugin> = {};
    const adapter = new FakeAdapter({ 'plugin-one': '1.0.0' });

    const results = await checkForUpdates(MIRROR, trackedPlugins, adapter);

    expect(trackedPlugins['plugin-one']).toEqual({
      repo: 'acme/plugin-one',
      installedVersion: '1.0.0',
      allowPrerelease: false,
      name: 'Plugin One',
    });
    expect(results).toEqual([
      {
        pluginId: 'plugin-one',
        status: 'update-available',
        candidate: { version: '2.0.0', prerelease: false, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      },
    ]);
  });

  it('does not adopt a registry plugin that has no matching folder on disk', async () => {
    server.use(
      http.get(`${MIRROR}/index.json`, () =>
        HttpResponse.json({
          generatedAt: '2026-01-01T00:00:00Z',
          plugins: [
            {
              id: 'plugin-not-installed',
              name: 'Not Installed',
              author: 'acme',
              description: 'desc',
              repo: 'acme/plugin-not-installed',
              latestVersion: '1.0.0',
              latestPrerelease: null,
            },
          ],
        })
      )
    );
    const trackedPlugins: Record<string, TrackedPlugin> = {};

    const results = await checkForUpdates(MIRROR, trackedPlugins, new FakeAdapter());

    expect(trackedPlugins).toEqual({});
    expect(results).toEqual([]);
  });

  it('proceeds with existing tracked plugins when the registry index is unreachable', async () => {
    server.use(
      http.get(`${MIRROR}/index.json`, () => HttpResponse.json({}, { status: 500 })),
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

  it('checks tracked plugins concurrently rather than one at a time, and stays correct at scale', async () => {
    const pluginCount = 30;
    let inFlight = 0;
    let maxInFlight = 0;
    server.use(
      http.get(`${MIRROR}/plugins/acme/:repo/versions.json`, async ({ params }) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return HttpResponse.json({
          repo: `acme/${params.repo}`,
          latest: null,
          versions: [
            { version: '2.0.0', prerelease: false, publishedAt: '2026-03-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
          ],
        });
      })
    );
    const tracked: Record<string, TrackedPlugin> = {};
    for (let i = 0; i < pluginCount; i++) {
      tracked[`plugin-${i}`] = { repo: `acme/plugin-${i}`, installedVersion: '1.0.0', allowPrerelease: false };
    }

    const results = await checkForUpdates(MIRROR, tracked, new FakeAdapter());

    expect(maxInFlight).toBeGreaterThan(1);
    expect(results).toHaveLength(pluginCount);
    expect(results.every((r) => r.status === 'update-available')).toBe(true);
  });

  it('does not adopt a plugin whose id is in excludeIds, even if it is found on disk', async () => {
    server.use(
      http.get(`${MIRROR}/index.json`, () =>
        HttpResponse.json({
          generatedAt: '2026-01-01T00:00:00Z',
          plugins: [
            {
              id: 'obsidian-mirror-installer',
              name: 'Mirror Installer',
              author: 'acme',
              description: 'desc',
              repo: 'acme/obsidian-plugin-mirror',
              latestVersion: '2.0.0',
              latestPrerelease: null,
            },
          ],
        })
      )
    );
    const trackedPlugins: Record<string, TrackedPlugin> = {};
    const adapter = new FakeAdapter({ 'obsidian-mirror-installer': '1.0.0' });

    const results = await checkForUpdates(MIRROR, trackedPlugins, adapter, fetch, ['obsidian-mirror-installer']);

    expect(trackedPlugins).toEqual({});
    expect(results).toEqual([]);
  });

  it('self-heals a stale excludeIds entry already present in trackedPlugins, instead of checking it', async () => {
    // Simulates a plugin id (e.g. this plugin's own) that ended up tracked
    // before excludeIds existed, or from a mirror registry shape that no
    // longer publishes an entry for it — checking it would 404 forever.
    server.use(http.get(`${MIRROR}/index.json`, () => HttpResponse.json({ generatedAt: '2026-01-01T00:00:00Z', plugins: [] })));
    const trackedPlugins: Record<string, TrackedPlugin> = {
      'obsidian-mirror-installer': { repo: 'acme/obsidian-plugin-mirror', installedVersion: '1.0.0', allowPrerelease: false },
      'other-plugin': { repo: 'acme/other-plugin', installedVersion: '1.0.0', allowPrerelease: false },
    };
    server.use(
      http.get(`${MIRROR}/plugins/acme/other-plugin/versions.json`, () =>
        HttpResponse.json({ repo: 'acme/other-plugin', latest: null, versions: [] })
      )
    );
    const adapter = new FakeAdapter();

    const results = await checkForUpdates(MIRROR, trackedPlugins, adapter, fetch, ['obsidian-mirror-installer']);

    expect(trackedPlugins).toEqual({
      'other-plugin': { repo: 'acme/other-plugin', installedVersion: '1.0.0', allowPrerelease: false },
    });
    expect(results).toEqual([{ pluginId: 'other-plugin', status: 'up-to-date' }]);
  });

  it('stops tracking a plugin removed via Obsidian\'s own Community Plugins page, instead of checking a stale entry', async () => {
    const trackedPlugins: Record<string, TrackedPlugin> = {
      'still-here': { repo: 'acme/still-here', installedVersion: '1.0.0', allowPrerelease: false },
      'removed-externally': { repo: 'acme/removed-externally', installedVersion: '1.0.0', allowPrerelease: false },
    };
    server.use(
      versionsHandler('acme/still-here', [
        { version: '1.0.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z', files: ['manifest.json'] },
      ])
    );
    // acme/removed-externally deliberately has no versions.json handler —
    // if checkForUpdates still tried to check it, this would surface as an
    // 'error' result instead of the plugin simply being gone from the list.
    const adapter = new FakeAdapter({}, ['removed-externally']);

    const results = await checkForUpdates(MIRROR, trackedPlugins, adapter, fetch);

    expect(trackedPlugins).toEqual({
      'still-here': { repo: 'acme/still-here', installedVersion: '1.0.0', allowPrerelease: false },
    });
    expect(results).toEqual([{ pluginId: 'still-here', status: 'up-to-date' }]);
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
