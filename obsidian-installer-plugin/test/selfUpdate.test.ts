import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { checkSelfUpdate, downloadSelfUpdate } from '../src/selfUpdate';
import type { VaultAdapterLike } from '../src/installer';

const MIRROR = 'https://plugins.internal.example.test';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function manifestHandler(version: string) {
  return http.get(`${MIRROR}/self/manifest.json`, () =>
    HttpResponse.json({ id: 'obsidian-mirror-installer', version })
  );
}

describe('checkSelfUpdate', () => {
  it('returns update-available when the mirror has a newer version', async () => {
    server.use(manifestHandler('1.0.5'));
    const result = await checkSelfUpdate(MIRROR, '1.0.4');
    expect(result).toEqual({ status: 'update-available', version: '1.0.5' });
  });

  it('returns up-to-date when already on the newest version', async () => {
    server.use(manifestHandler('1.0.4'));
    const result = await checkSelfUpdate(MIRROR, '1.0.4');
    expect(result).toEqual({ status: 'up-to-date' });
  });

  it('returns up-to-date when the installed version is newer (e.g. dev build)', async () => {
    server.use(manifestHandler('1.0.4'));
    const result = await checkSelfUpdate(MIRROR, '1.0.5');
    expect(result).toEqual({ status: 'up-to-date' });
  });

  it('returns error when the request fails', async () => {
    server.use(http.get(`${MIRROR}/self/manifest.json`, () => HttpResponse.json({}, { status: 500 })));
    const result = await checkSelfUpdate(MIRROR, '1.0.4');
    expect(result.status).toBe('error');
  });

  it('returns error when the mirror returns an invalid manifest', async () => {
    server.use(http.get(`${MIRROR}/self/manifest.json`, () => HttpResponse.json({ id: 'x' })));
    const result = await checkSelfUpdate(MIRROR, '1.0.4');
    expect(result.status).toBe('error');
  });
});

describe('downloadSelfUpdate', () => {
  it('writes manifest.json and main.js into the plugin folder', async () => {
    server.use(
      http.get(`${MIRROR}/self/manifest.json`, () => HttpResponse.text('{"id":"obsidian-mirror-installer","version":"1.0.5"}')),
      http.get(`${MIRROR}/self/main.js`, () => HttpResponse.text('console.log("main");'))
    );
    const written: Record<string, string> = {};
    const adapter: VaultAdapterLike = {
      mkdir: async () => {},
      write: async (path, data) => {
        written[path] = data;
      },
      rmdir: async () => {},
      read: async () => '',
    };

    await downloadSelfUpdate(adapter, MIRROR, 'obsidian-mirror-installer');

    expect(written['.obsidian/plugins/obsidian-mirror-installer/manifest.json']).toContain('1.0.5');
    expect(written['.obsidian/plugins/obsidian-mirror-installer/main.js']).toBe('console.log("main");');
  });

  it('throws when a file fails to download', async () => {
    server.use(http.get(`${MIRROR}/self/manifest.json`, () => HttpResponse.json({}, { status: 404 })));
    const adapter: VaultAdapterLike = { mkdir: async () => {}, write: async () => {}, rmdir: async () => {}, read: async () => '' };
    await expect(downloadSelfUpdate(adapter, MIRROR, 'obsidian-mirror-installer')).rejects.toThrow();
  });
});
