import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import {
  rankByDownloads,
  computeAdditions,
  applySync,
  fetchCommunityPluginsData,
  type CommunityPlugin,
  type CommunityPluginStats,
  type TrackedConfig,
} from '../src/syncTopPlugins.js';

function plugin(overrides: Partial<CommunityPlugin> = {}): CommunityPlugin {
  return {
    id: 'plugin-one',
    name: 'Plugin One',
    author: 'acme',
    repo: 'acme/plugin-one',
    ...overrides,
  };
}

describe('rankByDownloads', () => {
  it('sorts plugins newest-downloads-first, defaulting missing stats to 0', () => {
    const plugins = [
      plugin({ id: 'a', repo: 'acme/a' }),
      plugin({ id: 'b', repo: 'acme/b' }),
      plugin({ id: 'c', repo: 'acme/c' }),
    ];
    const stats: Record<string, CommunityPluginStats> = {
      a: { downloads: 100 },
      b: { downloads: 500 },
      // c has no stats entry at all
    };
    const ranked = rankByDownloads(plugins, stats);
    expect(ranked.map((r) => r.repo)).toEqual(['acme/b', 'acme/a', 'acme/c']);
    expect(ranked.map((r) => r.downloads)).toEqual([500, 100, 0]);
  });
});

describe('computeAdditions', () => {
  const ranked = [
    { repo: 'acme/top-one', name: 'Top One', id: 'top-one', downloads: 1000 },
    { repo: 'acme/top-two', name: 'Top Two', id: 'top-two', downloads: 900 },
    { repo: 'newowner/moved-plugin', name: 'Moved Plugin', id: 'moved-plugin', downloads: 800 },
    { repo: 'acme/top-four', name: 'Top Four', id: 'top-four', downloads: 700 },
  ];

  it('adds ranked repos not already tracked', () => {
    const result = computeAdditions([], ranked, 4);
    expect(result.toAdd.map((p) => p.repo)).toEqual([
      'acme/top-one',
      'acme/top-two',
      'newowner/moved-plugin',
      'acme/top-four',
    ]);
    expect(result.likelyMoved).toEqual([]);
  });

  it('skips a repo that is already tracked under the exact same string', () => {
    const result = computeAdditions(['acme/top-one'], ranked, 4);
    expect(result.toAdd.map((p) => p.repo)).not.toContain('acme/top-one');
  });

  it('is case-insensitive when matching already-tracked repos', () => {
    const result = computeAdditions(['ACME/Top-One'], ranked, 4);
    expect(result.toAdd.map((p) => p.repo)).not.toContain('acme/top-one');
  });

  it('flags a same-reponame-different-owner match as likely-moved instead of adding it', () => {
    const result = computeAdditions(['oldowner/moved-plugin'], ranked, 4);
    expect(result.toAdd.map((p) => p.repo)).not.toContain('newowner/moved-plugin');
    expect(result.likelyMoved).toEqual([
      { rankedRepo: 'newowner/moved-plugin', trackedRepo: 'oldowner/moved-plugin', name: 'Moved Plugin' },
    ]);
  });

  it('only considers the top N ranked entries', () => {
    const result = computeAdditions([], ranked, 2);
    expect(result.toAdd.map((p) => p.repo)).toEqual(['acme/top-one', 'acme/top-two']);
  });
});

describe('applySync', () => {
  function baseConfig(): TrackedConfig {
    return {
      defaultRetain: 5,
      plugins: [{ repo: 'oldowner/moved-plugin' }],
    };
  }

  it('appends new entries without touching existing ones', () => {
    const config = baseConfig();
    const result = applySync(
      config,
      { toAdd: [{ repo: 'acme/new-plugin', name: 'New Plugin', id: 'new-plugin', downloads: 100 }], likelyMoved: [] },
      false
    );
    expect(result.config.plugins).toEqual([{ repo: 'oldowner/moved-plugin' }, { repo: 'acme/new-plugin' }]);
    expect(result.addedCount).toBe(1);
    expect(result.replacedCount).toBe(0);
  });

  it('does not replace a likely-moved repo unless replaceMoved is true', () => {
    const config = baseConfig();
    const result = applySync(
      config,
      {
        toAdd: [],
        likelyMoved: [{ rankedRepo: 'newowner/moved-plugin', trackedRepo: 'oldowner/moved-plugin', name: 'Moved Plugin' }],
      },
      false
    );
    expect(result.config.plugins).toEqual([{ repo: 'oldowner/moved-plugin' }]);
    expect(result.replacedCount).toBe(0);
  });

  it('replaces a likely-moved repo in place when replaceMoved is true', () => {
    const config = baseConfig();
    const result = applySync(
      config,
      {
        toAdd: [],
        likelyMoved: [{ rankedRepo: 'newowner/moved-plugin', trackedRepo: 'oldowner/moved-plugin', name: 'Moved Plugin' }],
      },
      true
    );
    expect(result.config.plugins).toEqual([{ repo: 'newowner/moved-plugin' }]);
    expect(result.replacedCount).toBe(1);
    expect(result.addedCount).toBe(0);
  });
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('fetchCommunityPluginsData', () => {
  it('fetches and parses both community-plugins.json and community-plugin-stats.json', async () => {
    server.use(
      http.get('https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json', () =>
        HttpResponse.json([plugin()])
      ),
      http.get(
        'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json',
        () => HttpResponse.json({ 'plugin-one': { downloads: 42 } })
      )
    );
    const { plugins, stats } = await fetchCommunityPluginsData();
    expect(plugins).toEqual([plugin()]);
    expect(stats).toEqual({ 'plugin-one': { downloads: 42 } });
  });

  it('throws when community-plugins.json fails to fetch', async () => {
    server.use(
      http.get('https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json', () =>
        HttpResponse.json({}, { status: 500 })
      ),
      http.get(
        'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json',
        () => HttpResponse.json({})
      )
    );
    await expect(fetchCommunityPluginsData()).rejects.toThrow();
  });
});
