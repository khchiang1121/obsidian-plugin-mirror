import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { fetchIndex, fetchVersions, RegistryError } from '../src/registry';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const MIRROR = 'https://plugins.internal.example.test';

describe('fetchIndex', () => {
  it('parses index.json from the mirror', async () => {
    server.use(
      http.get(`${MIRROR}/index.json`, () =>
        HttpResponse.json({
          generatedAt: '2026-07-23T00:00:00Z',
          plugins: [
            {
              id: 'my-plugin-id',
              name: 'My Plugin',
              author: 'Some Author',
              description: 'What it does',
              repo: 'acme/my-plugin',
              latestVersion: '1.0.0',
              latestPrerelease: null,
            },
          ],
        })
      )
    );
    const index = await fetchIndex(MIRROR);
    expect(index.plugins).toHaveLength(1);
    expect(index.plugins[0].id).toBe('my-plugin-id');
  });

  it('handles a trailing slash on mirrorBaseUrl', async () => {
    server.use(
      http.get(`${MIRROR}/index.json`, () => HttpResponse.json({ generatedAt: '2026-07-23T00:00:00Z', plugins: [] }))
    );
    const index = await fetchIndex(`${MIRROR}/`);
    expect(index.plugins).toEqual([]);
  });

  it('throws RegistryError on a non-ok response', async () => {
    server.use(http.get(`${MIRROR}/index.json`, () => HttpResponse.json({}, { status: 500 })));
    await expect(fetchIndex(MIRROR)).rejects.toThrow(RegistryError);
  });
});

describe('fetchVersions', () => {
  it('parses versions.json for a given repo', async () => {
    server.use(
      http.get(`${MIRROR}/plugins/acme/my-plugin/versions.json`, () =>
        HttpResponse.json({
          repo: 'acme/my-plugin',
          latest: '1.0.0',
          versions: [
            { version: '1.0.0', prerelease: false, publishedAt: '2026-07-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
          ],
        })
      )
    );
    const data = await fetchVersions(MIRROR, 'acme/my-plugin');
    expect(data.latest).toBe('1.0.0');
    expect(data.versions).toHaveLength(1);
  });

  it('throws RegistryError on a 404', async () => {
    server.use(http.get(`${MIRROR}/plugins/acme/missing/versions.json`, () => HttpResponse.json({}, { status: 404 })));
    await expect(fetchVersions(MIRROR, 'acme/missing')).rejects.toThrow(RegistryError);
  });
});
