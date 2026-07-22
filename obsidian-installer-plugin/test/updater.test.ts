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
    const results = await checkForUpdates(MIRROR, tracked);
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
    const results = await checkForUpdates(MIRROR, tracked);
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
    const results = await checkForUpdates(MIRROR, tracked);
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
    const results = await checkForUpdates(MIRROR, tracked);
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
    const results = await checkForUpdates(MIRROR, tracked);
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
    const results = await checkForUpdates(MIRROR, tracked);
    expect(results[0].status).toBe('update-available');
  });
});

describe('applyUpdate', () => {
  class FakeAdapter implements VaultAdapterLike {
    writes: Array<{ path: string; data: string }> = [];
    async mkdir(): Promise<void> {}
    async write(path: string, data: string): Promise<void> {
      this.writes.push({ path, data });
    }
    async rmdir(): Promise<void> {}
  }
  class FakePluginManager implements PluginManagerLike {
    enabled: string[] = [];
    async enablePlugin(id: string): Promise<void> {
      this.enabled.push(id);
    }
    async disablePlugin(): Promise<void> {}
  }

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
