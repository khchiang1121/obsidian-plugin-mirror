import { describe, it, expect, beforeEach } from 'vitest';
import {
  installPluginVersion,
  removePlugin,
  type VaultAdapterLike,
  type PluginManagerLike,
} from '../src/installer';

class FakeAdapter implements VaultAdapterLike {
  mkdirCalls: string[] = [];
  writeCalls: Array<{ path: string; data: string }> = [];
  rmdirCalls: Array<{ path: string; recursive: boolean }> = [];

  async mkdir(path: string): Promise<void> {
    this.mkdirCalls.push(path);
  }
  async write(path: string, data: string): Promise<void> {
    this.writeCalls.push({ path, data });
  }
  async rmdir(path: string, recursive: boolean): Promise<void> {
    this.rmdirCalls.push({ path, recursive });
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

describe('removePlugin', () => {
  it('disables the plugin and removes its directory', async () => {
    await removePlugin(adapter, pluginManager, 'acme-plugin');
    expect(pluginManager.disabled).toEqual(['acme-plugin']);
    expect(adapter.rmdirCalls).toEqual([{ path: '.obsidian/plugins/acme-plugin', recursive: true }]);
  });
});
