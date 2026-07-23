import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

const server = setupServer();
let tempDir: string;
let downloadCallLog: string[];

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mirror-builder-cli-e2e-'));
  downloadCallLog = [];
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function manifestAsset(id: string, version: string) {
  return JSON.stringify({ id, name: id, version, author: 'Acme', description: `${id} description` });
}

function registerAssetHandlers() {
  server.use(
    http.get('https://assets.example.test/:version/manifest.json', ({ request, params }) => {
      downloadCallLog.push(request.url);
      return HttpResponse.text(manifestAsset('plugin-one', String(params.version)));
    }),
    http.get('https://assets.example.test/:version/main.js', ({ request }) => {
      downloadCallLog.push(request.url);
      return HttpResponse.text('console.log("main");');
    })
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
  it('mirrors a healthy plugin and skips a failing one, exiting 0', async () => {
    registerAssetHandlers();
    server.use(
      http.get('https://api.github.com/repos/acme/plugin-one/releases', () =>
        HttpResponse.json(releasesResponse([{ tag: '1.0.0', prerelease: false }]))
      ),
      http.get('https://api.github.com/repos/acme/plugin-broken/releases', () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 })
      )
    );

    const configPath = join(tempDir, 'tracked-plugins.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultRetain: 5,
        plugins: [{ repo: 'acme/plugin-one' }, { repo: 'acme/plugin-broken' }],
      })
    );
    const outDir = join(tempDir, 'dist');

    const exitCode = await run({ configPath, outDir });

    expect(exitCode).toBe(0);
    const index = JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf-8'));
    expect(index.plugins).toHaveLength(1);
    expect(index.plugins[0].repo).toBe('acme/plugin-one');
    expect(index.plugins[0].latestVersion).toBe('1.0.0');

    const versions = JSON.parse(
      readFileSync(join(outDir, 'plugins', 'acme', 'plugin-one', 'versions.json'), 'utf-8')
    );
    expect(versions.latest).toBe('1.0.0');
    expect(existsSync(join(outDir, 'plugins', 'acme', 'plugin-broken'))).toBe(false);
  });

  it('skips a plugin whose manifest.json is missing a required field, but still mirrors the rest', async () => {
    server.use(
      http.get('https://api.github.com/repos/acme/plugin-one/releases', () =>
        HttpResponse.json([
          {
            tag_name: '1.0.0',
            prerelease: false,
            published_at: '2026-01-01T00:00:00Z',
            created_at: '2026-01-01T00:00:00Z',
            assets: [
              { name: 'manifest.json', browser_download_url: 'https://assets.example.test/plugin-one/1.0.0/manifest.json' },
              { name: 'main.js', browser_download_url: 'https://assets.example.test/plugin-one/1.0.0/main.js' },
            ],
          },
        ])
      ),
      http.get('https://api.github.com/repos/acme/plugin-badmanifest/releases', () =>
        HttpResponse.json([
          {
            tag_name: '1.0.0',
            prerelease: false,
            published_at: '2026-01-01T00:00:00Z',
            created_at: '2026-01-01T00:00:00Z',
            assets: [
              {
                name: 'manifest.json',
                browser_download_url: 'https://assets.example.test/plugin-badmanifest/1.0.0/manifest.json',
              },
              { name: 'main.js', browser_download_url: 'https://assets.example.test/plugin-badmanifest/1.0.0/main.js' },
            ],
          },
        ])
      ),
      http.get('https://assets.example.test/plugin-one/1.0.0/manifest.json', () =>
        HttpResponse.text(manifestAsset('plugin-one', '1.0.0'))
      ),
      http.get('https://assets.example.test/plugin-one/1.0.0/main.js', () => HttpResponse.text('console.log("main");')),
      http.get('https://assets.example.test/plugin-badmanifest/1.0.0/manifest.json', () =>
        // Missing "author" and "description" — mirrors a real-world manifest.json that
        // doesn't declare every field readManifestMetadata requires.
        HttpResponse.text(JSON.stringify({ id: 'plugin-badmanifest', name: 'plugin-badmanifest' }))
      ),
      http.get('https://assets.example.test/plugin-badmanifest/1.0.0/main.js', () =>
        HttpResponse.text('console.log("main");')
      )
    );

    const configPath = join(tempDir, 'tracked-plugins.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultRetain: 5,
        plugins: [{ repo: 'acme/plugin-one' }, { repo: 'acme/plugin-badmanifest' }],
      })
    );
    const outDir = join(tempDir, 'dist');

    const exitCode = await run({ configPath, outDir });

    expect(exitCode).toBe(0);
    const index = JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf-8'));
    expect(index.plugins).toHaveLength(1);
    expect(index.plugins[0].repo).toBe('acme/plugin-one');
  });

  it('returns a non-zero exit code and writes nothing for an invalid config', async () => {
    const configPath = join(tempDir, 'tracked-plugins.json');
    writeFileSync(configPath, JSON.stringify({ defaultRetain: 5, plugins: [] }));
    const outDir = join(tempDir, 'dist');

    const exitCode = await run({ configPath, outDir });

    expect(exitCode).toBe(1);
    expect(existsSync(outDir)).toBe(false);
  });

  it('skips re-downloading an already-complete version and prunes retention on a second run', async () => {
    registerAssetHandlers();
    const configPath = join(tempDir, 'tracked-plugins.json');
    const outDir = join(tempDir, 'dist');
    writeFileSync(
      configPath,
      JSON.stringify({ defaultRetain: 1, plugins: [{ repo: 'acme/plugin-one' }] })
    );

    server.use(
      http.get('https://api.github.com/repos/acme/plugin-one/releases', () =>
        HttpResponse.json(releasesResponse([{ tag: '1.0.0', prerelease: false }]))
      )
    );
    await run({ configPath, outDir });
    expect(downloadCallLog).toHaveLength(2); // manifest.json + main.js for 1.0.0
    expect(existsSync(join(outDir, 'plugins', 'acme', 'plugin-one', '1.0.0'))).toBe(true);

    downloadCallLog = [];
    server.use(
      http.get('https://api.github.com/repos/acme/plugin-one/releases', () =>
        HttpResponse.json(
          releasesResponse([
            { tag: '2.0.0', prerelease: false },
            { tag: '1.0.0', prerelease: false },
          ])
        )
      )
    );
    await run({ configPath, outDir });

    // defaultRetain is 1, so only 2.0.0 should remain; 1.0.0 must be pruned.
    expect(existsSync(join(outDir, 'plugins', 'acme', 'plugin-one', '2.0.0'))).toBe(true);
    expect(existsSync(join(outDir, 'plugins', 'acme', 'plugin-one', '1.0.0'))).toBe(false);
    // Only 2.0.0's two assets should have been downloaded on the second run.
    expect(downloadCallLog).toHaveLength(2);
    expect(downloadCallLog.every((url) => url.includes('/2.0.0/'))).toBe(true);
  });

  it('pulls in an older stable version to satisfy minStableRetain even though it falls outside retain', async () => {
    registerAssetHandlers();
    server.use(
      http.get('https://api.github.com/repos/acme/plugin-one/releases', () =>
        HttpResponse.json(
          releasesResponse([
            { tag: '2.0.0-beta.2', prerelease: true },
            { tag: '2.0.0-beta.1', prerelease: true },
            { tag: '1.0.0', prerelease: false },
          ])
        )
      )
    );

    const configPath = join(tempDir, 'tracked-plugins.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultRetain: 1,
        defaultMinStableRetain: 1,
        plugins: [{ repo: 'acme/plugin-one' }],
      })
    );
    const outDir = join(tempDir, 'dist');

    const exitCode = await run({ configPath, outDir });

    expect(exitCode).toBe(0);
    const versions = JSON.parse(
      readFileSync(join(outDir, 'plugins', 'acme', 'plugin-one', 'versions.json'), 'utf-8')
    );
    expect(versions.versions.map((v: { version: string }) => v.version)).toEqual([
      '2.0.0-beta.2',
      '1.0.0',
    ]);
    expect(versions.latest).toBe('1.0.0');
    expect(existsSync(join(outDir, 'plugins', 'acme', 'plugin-one', '1.0.0'))).toBe(true);
  });
});
