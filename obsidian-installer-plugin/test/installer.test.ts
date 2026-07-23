import { describe, it, expect, beforeEach } from 'vitest';
import {
  installPluginVersion,
  downloadPluginFiles,
  removePlugin,
  readInstalledManifestVersion,
  adoptUntrackedInstalledPlugins,
  type VaultAdapterLike,
  type PluginManagerLike,
} from '../src/installer';
import type { RegistryEntry } from '../src/registry';
import type { TrackedPlugin } from '../src/settings';

class FakeAdapter implements VaultAdapterLike {
  mkdirCalls: string[] = [];
  writeCalls: Array<{ path: string; data: string }> = [];
  rmdirCalls: Array<{ path: string; recursive: boolean }> = [];
  files: Record<string, string> = {};

  async mkdir(path: string): Promise<void> {
    this.mkdirCalls.push(path);
  }
  async write(path: string, data: string): Promise<void> {
    this.writeCalls.push({ path, data });
  }
  async rmdir(path: string, recursive: boolean): Promise<void> {
    this.rmdirCalls.push({ path, recursive });
  }
  async read(path: string): Promise<string> {
    if (!(path in this.files)) {
      throw new Error(`ENOENT: ${path}`);
    }
    return this.files[path];
  }
}

class FakePluginManager implements PluginManagerLike {
  enabled: string[] = [];
  disabled: string[] = [];

  async enablePlugin(id: string): Promise<void> {
    this.enabled.push(id);
  }
  async disablePlugin(id: string): Promise<void> {
    this.disabled.push(id);
  }
}

let adapter: FakeAdapter;
let pluginManager: FakePluginManager;

beforeEach(() => {
  adapter = new FakeAdapter();
  pluginManager = new FakePluginManager();
});

function fakeFetch(fileContents: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const fileName = url.split('/').pop()!;
    if (!(fileName in fileContents)) {
      return new Response('not found', { status: 404 });
    }
    return new Response(fileContents[fileName], { status: 200 });
  }) as typeof fetch;
}

describe('installPluginVersion', () => {
  it('creates the plugin directory and writes each listed file', async () => {
    const fetchFn = fakeFetch({ 'manifest.json': '{"id":"acme"}', 'main.js': 'console.log(1)' });
    await installPluginVersion(
      adapter,
      pluginManager,
      'https://plugins.internal.example.test',
      'acme-plugin',
      { repo: 'acme/plugin', version: '1.0.0', files: ['manifest.json', 'main.js'] },
      fetchFn
    );

    expect(adapter.mkdirCalls).toEqual(['.obsidian/plugins/acme-plugin']);
    expect(adapter.writeCalls).toEqual([
      { path: '.obsidian/plugins/acme-plugin/manifest.json', data: '{"id":"acme"}' },
      { path: '.obsidian/plugins/acme-plugin/main.js', data: 'console.log(1)' },
    ]);
    expect(pluginManager.enabled).toEqual(['acme-plugin']);
  });

  it('fetches from the correct mirror URL for the repo and version', async () => {
    const requestedUrls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response('content', { status: 200 });
    }) as typeof fetch;

    await installPluginVersion(
      adapter,
      pluginManager,
      'https://plugins.internal.example.test/',
      'acme-plugin',
      { repo: 'acme/plugin', version: '2.0.0', files: ['manifest.json'] },
      fetchFn
    );

    expect(requestedUrls).toEqual([
      'https://plugins.internal.example.test/plugins/acme/plugin/2.0.0/manifest.json',
    ]);
  });

  it('throws and does not enable the plugin when a download fails', async () => {
    const fetchFn = fakeFetch({ 'manifest.json': '{}' }); // main.js missing -> 404
    await expect(
      installPluginVersion(
        adapter,
        pluginManager,
        'https://plugins.internal.example.test',
        'acme-plugin',
        { repo: 'acme/plugin', version: '1.0.0', files: ['manifest.json', 'main.js'] },
        fetchFn
      )
    ).rejects.toThrow();
    expect(pluginManager.enabled).toEqual([]);
  });

  it('tolerates mkdir failing because the directory already exists', async () => {
    const throwingAdapter: VaultAdapterLike = {
      ...adapter,
      mkdir: async () => {
        throw new Error('EEXIST');
      },
      write: adapter.write.bind(adapter),
      rmdir: adapter.rmdir.bind(adapter),
      read: adapter.read.bind(adapter),
    };
    const fetchFn = fakeFetch({ 'manifest.json': '{}' });
    await installPluginVersion(
      throwingAdapter,
      pluginManager,
      'https://plugins.internal.example.test',
      'acme-plugin',
      { repo: 'acme/plugin', version: '1.0.0', files: ['manifest.json'] },
      fetchFn
    );
    expect(pluginManager.enabled).toEqual(['acme-plugin']);
  });
});

describe('downloadPluginFiles', () => {
  it('writes each listed file without touching the plugin manager', async () => {
    const fetchFn = fakeFetch({ 'manifest.json': '{"id":"acme"}', 'main.js': 'console.log(1)' });
    await downloadPluginFiles(
      adapter,
      'https://plugins.internal.example.test',
      'acme-plugin',
      { repo: 'acme/plugin', version: '1.0.0', files: ['manifest.json', 'main.js'] },
      fetchFn
    );

    expect(adapter.writeCalls).toEqual([
      { path: '.obsidian/plugins/acme-plugin/manifest.json', data: '{"id":"acme"}' },
      { path: '.obsidian/plugins/acme-plugin/main.js', data: 'console.log(1)' },
    ]);
    expect(pluginManager.enabled).toEqual([]);
  });

  it('throws when a download fails', async () => {
    const fetchFn = fakeFetch({ 'manifest.json': '{}' }); // main.js missing -> 404
    await expect(
      downloadPluginFiles(
        adapter,
        'https://plugins.internal.example.test',
        'acme-plugin',
        { repo: 'acme/plugin', version: '1.0.0', files: ['manifest.json', 'main.js'] },
        fetchFn
      )
    ).rejects.toThrow();
  });
});

describe('removePlugin', () => {
  it('disables the plugin and removes its directory', async () => {
    await removePlugin(adapter, pluginManager, 'acme-plugin');
    expect(pluginManager.disabled).toEqual(['acme-plugin']);
    expect(adapter.rmdirCalls).toEqual([{ path: '.obsidian/plugins/acme-plugin', recursive: true }]);
  });
});

describe('readInstalledManifestVersion', () => {
  it('returns the version field from the on-disk manifest.json', async () => {
    adapter.files['.obsidian/plugins/acme-plugin/manifest.json'] = JSON.stringify({ version: '2.3.4' });
    expect(await readInstalledManifestVersion(adapter, 'acme-plugin')).toBe('2.3.4');
  });

  it('returns null when the manifest cannot be read', async () => {
    expect(await readInstalledManifestVersion(adapter, 'missing-plugin')).toBeNull();
  });

  it('returns null when the manifest has no string version field', async () => {
    adapter.files['.obsidian/plugins/acme-plugin/manifest.json'] = JSON.stringify({ id: 'acme-plugin' });
    expect(await readInstalledManifestVersion(adapter, 'acme-plugin')).toBeNull();
  });
});

function registryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: 'acme-plugin',
    name: 'Acme Plugin',
    author: 'acme',
    description: 'desc',
    repo: 'acme/plugin',
    latestVersion: '1.0.0',
    latestPrerelease: null,
    ...overrides,
  };
}

describe('adoptUntrackedInstalledPlugins', () => {
  it('adopts a registry plugin found on disk but not yet tracked, storing its display name', async () => {
    adapter.files['.obsidian/plugins/acme-plugin/manifest.json'] = JSON.stringify({ version: '1.0.0' });
    const trackedPlugins: Record<string, TrackedPlugin> = {};

    const adopted = await adoptUntrackedInstalledPlugins(adapter, trackedPlugins, [registryEntry()]);

    expect(adopted).toEqual(['acme-plugin']);
    expect(trackedPlugins['acme-plugin']).toEqual({
      repo: 'acme/plugin',
      installedVersion: '1.0.0',
      allowPrerelease: false,
      name: 'Acme Plugin',
    });
  });

  it('does not touch the version or prerelease flag of a plugin that is already tracked', async () => {
    adapter.files['.obsidian/plugins/acme-plugin/manifest.json'] = JSON.stringify({ version: '2.0.0' });
    const trackedPlugins: Record<string, TrackedPlugin> = {
      'acme-plugin': { repo: 'acme/plugin', installedVersion: '1.0.0', allowPrerelease: true, name: 'Acme Plugin' },
    };

    const adopted = await adoptUntrackedInstalledPlugins(adapter, trackedPlugins, [registryEntry()]);

    expect(adopted).toEqual([]);
    expect(trackedPlugins['acme-plugin']).toEqual({
      repo: 'acme/plugin',
      installedVersion: '1.0.0',
      allowPrerelease: true,
      name: 'Acme Plugin',
    });
  });

  it('backfills the display name for an already-tracked plugin that predates name tracking', async () => {
    const trackedPlugins: Record<string, TrackedPlugin> = {
      'acme-plugin': { repo: 'acme/plugin', installedVersion: '1.0.0', allowPrerelease: false },
    };

    const adopted = await adoptUntrackedInstalledPlugins(adapter, trackedPlugins, [registryEntry({ name: 'Acme Plugin' })]);

    expect(adopted).toEqual([]);
    expect(trackedPlugins['acme-plugin'].name).toBe('Acme Plugin');
  });

  it('syncs a tracked plugin name that has drifted from the registry', async () => {
    const trackedPlugins: Record<string, TrackedPlugin> = {
      'acme-plugin': { repo: 'acme/plugin', installedVersion: '1.0.0', allowPrerelease: false, name: 'Old Name' },
    };

    await adoptUntrackedInstalledPlugins(adapter, trackedPlugins, [registryEntry({ name: 'New Name' })]);

    expect(trackedPlugins['acme-plugin'].name).toBe('New Name');
  });

  it('skips registry entries with no matching plugin folder on disk', async () => {
    const trackedPlugins: Record<string, TrackedPlugin> = {};

    const adopted = await adoptUntrackedInstalledPlugins(adapter, trackedPlugins, [registryEntry()]);

    expect(adopted).toEqual([]);
    expect(trackedPlugins).toEqual({});
  });

  it('adopts multiple untracked plugins independently', async () => {
    adapter.files['.obsidian/plugins/acme-plugin/manifest.json'] = JSON.stringify({ version: '1.0.0' });
    adapter.files['.obsidian/plugins/other-plugin/manifest.json'] = JSON.stringify({ version: '3.1.0' });
    const trackedPlugins: Record<string, TrackedPlugin> = {};

    const adopted = await adoptUntrackedInstalledPlugins(adapter, trackedPlugins, [
      registryEntry(),
      registryEntry({ id: 'other-plugin', repo: 'other/plugin', name: 'Other Plugin' }),
    ]);

    expect(adopted.sort()).toEqual(['acme-plugin', 'other-plugin']);
    expect(trackedPlugins).toEqual({
      'acme-plugin': { repo: 'acme/plugin', installedVersion: '1.0.0', allowPrerelease: false, name: 'Acme Plugin' },
      'other-plugin': { repo: 'other/plugin', installedVersion: '3.1.0', allowPrerelease: false, name: 'Other Plugin' },
    });
  });

  it('checks disk reads concurrently rather than one at a time, and stays correct at scale', async () => {
    const entryCount = 50;
    let inFlight = 0;
    let maxInFlight = 0;
    const concurrentAdapter: VaultAdapterLike = {
      ...adapter,
      mkdir: adapter.mkdir.bind(adapter),
      write: adapter.write.bind(adapter),
      rmdir: adapter.rmdir.bind(adapter),
      read: async (path: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const match = /\.obsidian\/plugins\/([^/]+)\/manifest\.json$/.exec(path);
        const id = match?.[1];
        if (id && Number(id.replace('plugin-', '')) % 2 === 0) {
          return JSON.stringify({ version: '1.0.0' });
        }
        throw new Error('ENOENT');
      },
    };

    const entries = Array.from({ length: entryCount }, (_, i) =>
      registryEntry({ id: `plugin-${i}`, repo: `acme/plugin-${i}`, name: `Plugin ${i}` })
    );
    const trackedPlugins: Record<string, TrackedPlugin> = {};

    const adopted = await adoptUntrackedInstalledPlugins(concurrentAdapter, trackedPlugins, entries);

    expect(maxInFlight).toBeGreaterThan(1);
    expect(adopted.sort()).toEqual(
      Array.from({ length: entryCount / 2 }, (_, i) => `plugin-${i * 2}`).sort()
    );
    expect(Object.keys(trackedPlugins)).toHaveLength(entryCount / 2);
  });
});
