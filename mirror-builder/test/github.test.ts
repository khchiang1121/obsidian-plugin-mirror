import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createGithubClient, fetchReleasesForRepo, fetchReleasesForRepos } from '../src/github.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function release(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tag_name: '1.0.0',
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    assets: [
      { name: 'manifest.json', browser_download_url: 'https://assets.example.test/manifest.json' },
      { name: 'main.js', browser_download_url: 'https://assets.example.test/main.js' },
    ],
    ...overrides,
  };
}

describe('fetchReleasesForRepo', () => {
  it('maps GitHub release fields to FetchedRelease', async () => {
    server.use(
      http.get('https://api.github.com/repos/acme/plugin-one/releases', () =>
        HttpResponse.json([release()])
      )
    );
    const client = createGithubClient();
    const releases = await fetchReleasesForRepo(client, 'acme/plugin-one');
    expect(releases).toEqual([
      {
        tagName: '1.0.0',
        prerelease: false,
        publishedAt: '2026-01-01T00:00:00Z',
        assets: [
          { name: 'manifest.json', downloadUrl: 'https://assets.example.test/manifest.json' },
          { name: 'main.js', downloadUrl: 'https://assets.example.test/main.js' },
        ],
      },
    ]);
  });

  it('follows pagination via the Link header', async () => {
    let callCount = 0;
    server.use(
      http.get('https://api.github.com/repos/acme/plugin-paged/releases', ({ request }) => {
        callCount += 1;
        const url = new URL(request.url);
        const page = url.searchParams.get('page') ?? '1';
        if (page === '1') {
          return HttpResponse.json([release({ tag_name: '2.0.0' })], {
            headers: {
              Link: '<https://api.github.com/repos/acme/plugin-paged/releases?page=2>; rel="next"',
            },
          });
        }
        return HttpResponse.json([release({ tag_name: '1.0.0' })]);
      })
    );
    const client = createGithubClient();
    const releases = await fetchReleasesForRepo(client, 'acme/plugin-paged');
    expect(releases.map((r) => r.tagName)).toEqual(['2.0.0', '1.0.0']);
    expect(callCount).toBe(2);
  });

  it('throws when the repo does not exist', async () => {
    server.use(
      http.get('https://api.github.com/repos/acme/missing/releases', () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 })
      )
    );
    const client = createGithubClient();
    await expect(fetchReleasesForRepo(client, 'acme/missing')).rejects.toThrow();
  });
});

describe('fetchReleasesForRepos', () => {
  it('isolates a single repo failure from the rest', async () => {
    server.use(
      http.get('https://api.github.com/repos/acme/good/releases', () => HttpResponse.json([release()])),
      http.get('https://api.github.com/repos/acme/bad/releases', () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 })
      )
    );
    const client = createGithubClient();
    const results = await fetchReleasesForRepos(client, ['acme/good', 'acme/bad']);
    expect(results.get('acme/good')?.status).toBe('ok');
    expect(results.get('acme/bad')?.status).toBe('error');
  });
});
