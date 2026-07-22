# mirror-builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mirror-builder CLI (Subsystem A) that reads a tracked-plugin config, fetches GitHub releases, and produces a static file tree matching the shared mirror format spec, ready to be packaged into an nginx Docker image.

**Architecture:** A Node.js/TypeScript CLI (`mirror-builder/`) with one focused module per pipeline stage (config → github fetch → sort/retain → asset validation/download/prune → manifest metadata → JSON writer), orchestrated by `cli.ts`. All I/O-heavy modules are covered by unit tests using mocked HTTP; `cli.ts` additionally gets an end-to-end test against a fully mocked GitHub API. A checked-in Dockerfile plus an npm script chain the CLI and `docker build` into one command.

**Tech Stack:** TypeScript (ESM, Node 22), `@octokit/rest` for GitHub API access, `p-limit` for bounded concurrency, `semver` for version comparison, `vitest` as test runner, `msw` (`msw/node`) for HTTP mocking (chosen over `nock` because `@octokit/rest` v21 uses native `fetch`/undici, which `nock`'s classic `http` interception does not reliably catch — msw's fetch interceptor does), `tsx` to run TypeScript directly (no separate compile step needed since this is a CLI tool, not a published library).

## Global Constraints

- Directory/file layout and JSON schemas (`index.json`, `versions.json`, version directories) must match `docs/superpowers/specs/2026-07-23-mirror-format-design.md` exactly — this is a contract with Subsystem B.
- Version sort rule: compare coerced semver when both tags parse as valid versions; otherwise fall back to comparing `publishedAt`. (Same spec, and `docs/superpowers/specs/2026-07-23-mirror-builder-design.md`.)
- A version is only mirrorable if both `manifest.json` and `main.js` are present as release assets; `styles.css` and `manifest-beta.json` are optional.
- One plugin's fetch/validation failure must never abort the whole run; only a bad/missing config file is a fatal error (non-zero exit).
- Re-running against an existing output directory must skip downloading already-complete version directories, and must prune version directories that fall outside the newly computed retained set.
- The core CLI must have zero Docker dependency; `docker build` only happens via an explicit npm script, never invoked by the CLI itself.
- All source lives under `mirror-builder/` at the repo root (sibling to `docs/`), since Subsystem B will later get its own sibling directory with different tooling.

---

## Task 1: Project scaffolding

**Files:**
- Create: `mirror-builder/package.json`
- Create: `mirror-builder/tsconfig.json`
- Create: `mirror-builder/vitest.config.ts`
- Create: `mirror-builder/src/smoke.ts`
- Test: `mirror-builder/test/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm test` command and TS/ESM toolchain that every later task builds on.

- [ ] **Step 1: Create the package directory and initialize `package.json`**

```bash
mkdir -p /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder/src
mkdir -p /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder/test
cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder
npm init -y
```

- [ ] **Step 2: Set `package.json` to ESM and add scripts**

Edit `mirror-builder/package.json` so it looks like this (keep the `name`/`version` npm generated, just add/overwrite the fields below):

```json
{
  "name": "mirror-builder",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "generate": "tsx src/cli.ts",
    "test": "vitest run",
    "build:image": "npm run generate -- --config tracked-plugins.json --out dist && docker build -t obsidian-plugin-mirror -f Dockerfile ."
  }
}
```

- [ ] **Step 3: Install dependencies**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder
npm install @octokit/rest semver p-limit
npm install --save-dev typescript vitest msw tsx @types/node @types/semver
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "build",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 5: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 6: Write a smoke test to validate the toolchain end-to-end**

Create `mirror-builder/src/smoke.ts`:

```typescript
export function add(a: number, b: number): number {
  return a + b;
}
```

Create `mirror-builder/test/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { add } from '../src/smoke.js';

describe('toolchain smoke test', () => {
  it('runs a basic TS test through vitest', () => {
    expect(add(2, 3)).toBe(5);
  });
});
```

- [ ] **Step 7: Run the test to confirm the toolchain works**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npm test`
Expected: 1 test passes (`toolchain smoke test > runs a basic TS test through vitest`)

- [ ] **Step 8: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/package.json mirror-builder/package-lock.json mirror-builder/tsconfig.json mirror-builder/vitest.config.ts mirror-builder/src/smoke.ts mirror-builder/test/smoke.test.ts
git commit -m "chore: scaffold mirror-builder TS project"
```

---

## Task 2: Config loader

**Files:**
- Create: `mirror-builder/src/config.ts`
- Create: `mirror-builder/test/fixtures/config/valid.json`
- Create: `mirror-builder/test/fixtures/config/empty-plugins.json`
- Create: `mirror-builder/test/fixtures/config/invalid-repo.json`
- Create: `mirror-builder/test/fixtures/config/invalid-retain.json`
- Create: `mirror-builder/test/fixtures/config/not-json.txt`
- Test: `mirror-builder/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(filePath: string): TrackedPluginsConfig`, `ConfigError`, `PluginConfigEntry { repo: string; retain?: number | 'all' }`, `TrackedPluginsConfig { defaultRetain: number | 'all'; plugins: PluginConfigEntry[] }`.

- [ ] **Step 1: Create fixture files**

`mirror-builder/test/fixtures/config/valid.json`:

```json
{
  "defaultRetain": 5,
  "plugins": [
    { "repo": "acme/plugin-one" },
    { "repo": "acme/plugin-two", "retain": 10 },
    { "repo": "acme/plugin-three", "retain": "all" }
  ]
}
```

`mirror-builder/test/fixtures/config/empty-plugins.json`:

```json
{
  "defaultRetain": 5,
  "plugins": []
}
```

`mirror-builder/test/fixtures/config/invalid-repo.json`:

```json
{
  "defaultRetain": 5,
  "plugins": [{ "repo": "not-a-valid-repo-string" }]
}
```

`mirror-builder/test/fixtures/config/invalid-retain.json`:

```json
{
  "defaultRetain": 5,
  "plugins": [{ "repo": "acme/plugin-one", "retain": -1 }]
}
```

`mirror-builder/test/fixtures/config/not-json.txt`:

```
this is not json {{{
```

- [ ] **Step 2: Write the failing tests**

Create `mirror-builder/test/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const fixture = (name: string) => new URL(`./fixtures/config/${name}`, import.meta.url).pathname;

describe('loadConfig', () => {
  it('parses a valid config file', () => {
    const config = loadConfig(fixture('valid.json'));
    expect(config.defaultRetain).toBe(5);
    expect(config.plugins).toEqual([
      { repo: 'acme/plugin-one', retain: undefined },
      { repo: 'acme/plugin-two', retain: 10 },
      { repo: 'acme/plugin-three', retain: 'all' },
    ]);
  });

  it('throws ConfigError when the file does not exist', () => {
    expect(() => loadConfig(fixture('does-not-exist.json'))).toThrow(ConfigError);
  });

  it('throws ConfigError when the file is not valid JSON', () => {
    expect(() => loadConfig(fixture('not-json.txt'))).toThrow(ConfigError);
  });

  it('throws ConfigError when plugins is empty', () => {
    expect(() => loadConfig(fixture('empty-plugins.json'))).toThrow(ConfigError);
  });

  it('throws ConfigError when a repo string is malformed', () => {
    expect(() => loadConfig(fixture('invalid-repo.json'))).toThrow(ConfigError);
  });

  it('throws ConfigError when retain is not a positive integer or "all"', () => {
    expect(() => loadConfig(fixture('invalid-retain.json'))).toThrow(ConfigError);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/config.test.ts`
Expected: FAIL — `src/config.ts` does not exist yet.

- [ ] **Step 4: Implement `config.ts`**

Create `mirror-builder/src/config.ts`:

```typescript
import { readFileSync } from 'node:fs';

export interface PluginConfigEntry {
  repo: string;
  retain?: number | 'all';
}

export interface TrackedPluginsConfig {
  defaultRetain: number | 'all';
  plugins: PluginConfigEntry[];
}

export class ConfigError extends Error {}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

function isValidRetain(value: unknown): value is number | 'all' {
  if (value === 'all') return true;
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function loadConfig(filePath: string): TrackedPluginsConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    throw new ConfigError(`Config file not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Config file is not valid JSON: ${filePath}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError('Config must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  if (!isValidRetain(obj.defaultRetain)) {
    throw new ConfigError('"defaultRetain" must be a positive integer or "all"');
  }

  if (!Array.isArray(obj.plugins) || obj.plugins.length === 0) {
    throw new ConfigError('"plugins" must be a non-empty array');
  }

  const plugins: PluginConfigEntry[] = obj.plugins.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigError(`plugins[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.repo !== 'string' || !REPO_PATTERN.test(e.repo)) {
      throw new ConfigError(`plugins[${i}].repo must be an "owner/repo" string`);
    }
    if (e.retain !== undefined && !isValidRetain(e.retain)) {
      throw new ConfigError(`plugins[${i}].retain must be a positive integer or "all"`);
    }
    return { repo: e.repo, retain: e.retain as number | 'all' | undefined };
  });

  return { defaultRetain: obj.defaultRetain, plugins };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/config.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/src/config.ts mirror-builder/test/config.test.ts mirror-builder/test/fixtures/config
git commit -m "feat(mirror-builder): add tracked-plugins config loader"
```

---

## Task 3: Version sort & retention

**Files:**
- Create: `mirror-builder/src/versionSort.ts`
- Test: `mirror-builder/test/versionSort.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ReleaseCandidate { version: string; prerelease: boolean; publishedAt: string }`, `sortReleasesNewestFirst<T extends ReleaseCandidate>(releases: T[]): T[]`, `applyRetention<T>(sortedNewestFirst: T[], retain: number | 'all'): T[]`.

- [ ] **Step 1: Write the failing tests**

Create `mirror-builder/test/versionSort.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { sortReleasesNewestFirst, applyRetention, type ReleaseCandidate } from '../src/versionSort.js';

function candidate(version: string, publishedAt: string, prerelease = false): ReleaseCandidate {
  return { version, publishedAt, prerelease };
}

describe('sortReleasesNewestFirst', () => {
  it('sorts valid semver tags newest-first by semver value', () => {
    const input = [
      candidate('1.0.0', '2026-01-01T00:00:00Z'),
      candidate('2.1.0', '2026-02-01T00:00:00Z'),
      candidate('1.5.0', '2026-01-15T00:00:00Z'),
    ];
    const sorted = sortReleasesNewestFirst(input);
    expect(sorted.map((r) => r.version)).toEqual(['2.1.0', '1.5.0', '1.0.0']);
  });

  it('falls back to publishedAt when tags are not valid semver', () => {
    const input = [
      candidate('release-a', '2026-01-01T00:00:00Z'),
      candidate('release-b', '2026-03-01T00:00:00Z'),
      candidate('release-c', '2026-02-01T00:00:00Z'),
    ];
    const sorted = sortReleasesNewestFirst(input);
    expect(sorted.map((r) => r.version)).toEqual(['release-b', 'release-c', 'release-a']);
  });

  it('falls back to publishedAt when only one of a pair is valid semver', () => {
    const input = [
      candidate('1.0.0', '2026-01-01T00:00:00Z'),
      candidate('nightly-build', '2026-06-01T00:00:00Z'),
    ];
    const sorted = sortReleasesNewestFirst(input);
    expect(sorted.map((r) => r.version)).toEqual(['nightly-build', '1.0.0']);
  });

  it('does not mutate the input array', () => {
    const input = [candidate('1.0.0', '2026-01-01T00:00:00Z'), candidate('2.0.0', '2026-02-01T00:00:00Z')];
    const original = [...input];
    sortReleasesNewestFirst(input);
    expect(input).toEqual(original);
  });
});

describe('applyRetention', () => {
  it('keeps only the first N entries for a numeric retain', () => {
    const input = [1, 2, 3, 4, 5];
    expect(applyRetention(input, 2)).toEqual([1, 2]);
  });

  it('keeps everything when retain is "all"', () => {
    const input = [1, 2, 3];
    expect(applyRetention(input, 'all')).toEqual([1, 2, 3]);
  });

  it('does not error when N exceeds the array length', () => {
    const input = [1, 2];
    expect(applyRetention(input, 10)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/versionSort.test.ts`
Expected: FAIL — `src/versionSort.ts` does not exist yet.

- [ ] **Step 3: Implement `versionSort.ts`**

Create `mirror-builder/src/versionSort.ts`:

```typescript
import semver from 'semver';

export interface ReleaseCandidate {
  version: string;
  prerelease: boolean;
  publishedAt: string;
}

function parseSemver(tag: string): string | null {
  const coerced = semver.coerce(tag);
  if (!coerced) return null;
  return semver.valid(coerced) ? coerced.version : null;
}

export function compareReleasesNewestFirst(a: ReleaseCandidate, b: ReleaseCandidate): number {
  const aVer = parseSemver(a.version);
  const bVer = parseSemver(b.version);
  if (aVer && bVer) {
    return semver.compare(bVer, aVer);
  }
  return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
}

export function sortReleasesNewestFirst<T extends ReleaseCandidate>(releases: T[]): T[] {
  return [...releases].sort(compareReleasesNewestFirst);
}

export function applyRetention<T>(sortedNewestFirst: T[], retain: number | 'all'): T[] {
  if (retain === 'all') return [...sortedNewestFirst];
  return sortedNewestFirst.slice(0, retain);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/versionSort.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/src/versionSort.ts mirror-builder/test/versionSort.test.ts
git commit -m "feat(mirror-builder): add semver-with-fallback sort and retention"
```

---

## Task 4: GitHub release fetching

**Files:**
- Create: `mirror-builder/src/github.ts`
- Test: `mirror-builder/test/github.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FetchedReleaseAsset { name: string; downloadUrl: string }`, `FetchedRelease { tagName: string; prerelease: boolean; publishedAt: string; assets: FetchedReleaseAsset[] }`, `RepoFetchResult = { status: 'ok'; releases: FetchedRelease[] } | { status: 'error'; error: Error }`, `createGithubClient(token?: string): Octokit`, `fetchReleasesForRepo(client: Octokit, repo: string): Promise<FetchedRelease[]>`, `fetchReleasesForRepos(client: Octokit, repos: string[], concurrency?: number): Promise<Map<string, RepoFetchResult>>`.

- [ ] **Step 1: Write the failing tests**

Create `mirror-builder/test/github.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/github.test.ts`
Expected: FAIL — `src/github.ts` does not exist yet.

- [ ] **Step 3: Implement `github.ts`**

Create `mirror-builder/src/github.ts`:

```typescript
import { Octokit } from '@octokit/rest';
import pLimit from 'p-limit';

export interface FetchedReleaseAsset {
  name: string;
  downloadUrl: string;
}

export interface FetchedRelease {
  tagName: string;
  prerelease: boolean;
  publishedAt: string;
  assets: FetchedReleaseAsset[];
}

export function createGithubClient(token?: string): Octokit {
  return new Octokit(token ? { auth: token } : {});
}

export async function fetchReleasesForRepo(client: Octokit, repo: string): Promise<FetchedRelease[]> {
  const [owner, name] = repo.split('/');
  const releases = await client.paginate(client.rest.repos.listReleases, {
    owner,
    repo: name,
    per_page: 100,
  });
  return releases.map((r) => ({
    tagName: r.tag_name,
    prerelease: r.prerelease,
    publishedAt: r.published_at ?? r.created_at,
    assets: r.assets.map((a) => ({ name: a.name, downloadUrl: a.browser_download_url })),
  }));
}

export type RepoFetchResult =
  | { status: 'ok'; releases: FetchedRelease[] }
  | { status: 'error'; error: Error };

export async function fetchReleasesForRepos(
  client: Octokit,
  repos: string[],
  concurrency = 5
): Promise<Map<string, RepoFetchResult>> {
  const limit = pLimit(concurrency);
  const results = new Map<string, RepoFetchResult>();
  await Promise.all(
    repos.map((repo) =>
      limit(async () => {
        try {
          const releases = await fetchReleasesForRepo(client, repo);
          results.set(repo, { status: 'ok', releases });
        } catch (error) {
          results.set(repo, { status: 'error', error: error as Error });
        }
      })
    )
  );
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/github.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/src/github.ts mirror-builder/test/github.test.ts
git commit -m "feat(mirror-builder): add GitHub release fetching with bounded concurrency"
```

---

## Task 5: Release validation, download, and pruning

**Files:**
- Create: `mirror-builder/src/assets.ts`
- Test: `mirror-builder/test/assets.test.ts`

**Interfaces:**
- Consumes: `FetchedRelease` from Task 4 (`github.ts`).
- Produces: `REQUIRED_ASSET_NAMES`, `OPTIONAL_ASSET_NAMES`, `ValidatedVersion { version: string; prerelease: boolean; publishedAt: string; files: string[]; assetUrls: Record<string,string> }`, `validateRelease(release: FetchedRelease): ValidatedVersion | null`, `isVersionDirComplete(versionDir: string, expectedFiles: string[]): boolean`, `downloadFile(url: string, destPath: string, token?: string): Promise<void>`, `ensureVersionAssets(pluginDir: string, version: ValidatedVersion, token?: string, downloader?: Downloader): Promise<'skipped' | 'downloaded'>`, `pruneStaleVersionDirs(pluginDir: string, retainedVersions: string[]): string[]`.

- [ ] **Step 1: Write the failing tests**

Create `mirror-builder/test/assets.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateRelease,
  isVersionDirComplete,
  ensureVersionAssets,
  pruneStaleVersionDirs,
  type ValidatedVersion,
} from '../src/assets.js';
import type { FetchedRelease } from '../src/github.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mirror-builder-assets-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function release(assetNames: string[]): FetchedRelease {
  return {
    tagName: '1.0.0',
    prerelease: false,
    publishedAt: '2026-01-01T00:00:00Z',
    assets: assetNames.map((name) => ({ name, downloadUrl: `https://assets.example.test/${name}` })),
  };
}

describe('validateRelease', () => {
  it('returns null when main.js is missing', () => {
    expect(validateRelease(release(['manifest.json']))).toBeNull();
  });

  it('returns null when manifest.json is missing', () => {
    expect(validateRelease(release(['main.js']))).toBeNull();
  });

  it('includes optional files only when present, required-first', () => {
    const validated = validateRelease(release(['manifest.json', 'main.js', 'styles.css']));
    expect(validated?.files).toEqual(['manifest.json', 'main.js', 'styles.css']);
  });

  it('excludes optional files that are absent', () => {
    const validated = validateRelease(release(['manifest.json', 'main.js']));
    expect(validated?.files).toEqual(['manifest.json', 'main.js']);
  });
});

describe('isVersionDirComplete', () => {
  it('is false when the directory does not exist', () => {
    expect(isVersionDirComplete(join(tempDir, 'missing'), ['manifest.json'])).toBe(false);
  });

  it('is false when a required file is missing', () => {
    const dir = join(tempDir, 'v1');
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), '{}');
    expect(isVersionDirComplete(dir, ['manifest.json', 'main.js'])).toBe(false);
  });

  it('is true when all expected files are present', () => {
    const dir = join(tempDir, 'v1');
    mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), '{}');
    writeFileSync(join(dir, 'main.js'), '');
    expect(isVersionDirComplete(dir, ['manifest.json', 'main.js'])).toBe(true);
  });
});

describe('ensureVersionAssets', () => {
  const version: ValidatedVersion = {
    version: '1.0.0',
    prerelease: false,
    publishedAt: '2026-01-01T00:00:00Z',
    files: ['manifest.json', 'main.js'],
    assetUrls: {
      'manifest.json': 'https://assets.example.test/manifest.json',
      'main.js': 'https://assets.example.test/main.js',
    },
  };

  it('downloads assets when the version directory is missing', async () => {
    const calls: string[] = [];
    const result = await ensureVersionAssets(tempDir, version, undefined, async (url, dest) => {
      calls.push(url);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, 'stub');
    });
    expect(result).toBe('downloaded');
    expect(calls).toHaveLength(2);
    expect(existsSync(join(tempDir, '1.0.0', 'manifest.json'))).toBe(true);
  });

  it('skips downloading when the version directory is already complete', async () => {
    const dir = join(tempDir, '1.0.0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), 'existing');
    writeFileSync(join(dir, 'main.js'), 'existing');

    const calls: string[] = [];
    const result = await ensureVersionAssets(tempDir, version, undefined, async (url) => {
      calls.push(url);
    });
    expect(result).toBe('skipped');
    expect(calls).toHaveLength(0);
  });
});

describe('pruneStaleVersionDirs', () => {
  it('removes version directories not in the retained set', () => {
    const pluginDir = join(tempDir, 'plugin');
    mkdirSync(join(pluginDir, '1.0.0'), { recursive: true });
    mkdirSync(join(pluginDir, '2.0.0'), { recursive: true });
    mkdirSync(join(pluginDir, '3.0.0'), { recursive: true });

    const removed = pruneStaleVersionDirs(pluginDir, ['3.0.0']);

    expect(removed.sort()).toEqual(['1.0.0', '2.0.0']);
    expect(readdirSync(pluginDir)).toEqual(['3.0.0']);
  });

  it('returns an empty array when the plugin directory does not exist yet', () => {
    expect(pruneStaleVersionDirs(join(tempDir, 'does-not-exist'), ['1.0.0'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/assets.test.ts`
Expected: FAIL — `src/assets.ts` does not exist yet.

- [ ] **Step 3: Implement `assets.ts`**

Create `mirror-builder/src/assets.ts`:

```typescript
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchedRelease } from './github.js';

export const REQUIRED_ASSET_NAMES = ['manifest.json', 'main.js'] as const;
export const OPTIONAL_ASSET_NAMES = ['styles.css', 'manifest-beta.json'] as const;

export interface ValidatedVersion {
  version: string;
  prerelease: boolean;
  publishedAt: string;
  files: string[];
  assetUrls: Record<string, string>;
}

export function validateRelease(release: FetchedRelease): ValidatedVersion | null {
  const assetsByName = new Map(release.assets.map((a) => [a.name, a.downloadUrl]));
  for (const required of REQUIRED_ASSET_NAMES) {
    if (!assetsByName.has(required)) return null;
  }
  const files = [...REQUIRED_ASSET_NAMES, ...OPTIONAL_ASSET_NAMES].filter((name) =>
    assetsByName.has(name)
  );
  const assetUrls: Record<string, string> = {};
  for (const file of files) assetUrls[file] = assetsByName.get(file)!;
  return {
    version: release.tagName,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    files,
    assetUrls,
  };
}

export function isVersionDirComplete(versionDir: string, expectedFiles: string[]): boolean {
  return expectedFiles.every((file) => existsSync(join(versionDir, file)));
}

export type Downloader = (url: string, destPath: string, token?: string) => Promise<void>;

export async function downloadFile(url: string, destPath: string, token?: string): Promise<void> {
  const headers: Record<string, string> = { Accept: 'application/octet-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destPath, buffer);
}

export async function ensureVersionAssets(
  pluginDir: string,
  version: ValidatedVersion,
  token?: string,
  downloader: Downloader = downloadFile
): Promise<'skipped' | 'downloaded'> {
  const versionDir = join(pluginDir, version.version);
  if (existsSync(versionDir) && isVersionDirComplete(versionDir, version.files)) {
    return 'skipped';
  }
  mkdirSync(versionDir, { recursive: true });
  for (const file of version.files) {
    await downloader(version.assetUrls[file], join(versionDir, file), token);
  }
  return 'downloaded';
}

export function pruneStaleVersionDirs(pluginDir: string, retainedVersions: string[]): string[] {
  if (!existsSync(pluginDir)) return [];
  const retainedSet = new Set(retainedVersions);
  const removed: string[] = [];
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !retainedSet.has(entry.name)) {
      rmSync(join(pluginDir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/assets.test.ts`
Expected: PASS — 11 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/src/assets.ts mirror-builder/test/assets.test.ts
git commit -m "feat(mirror-builder): add release validation, incremental download, and pruning"
```

---

## Task 6: Manifest metadata reader

**Files:**
- Create: `mirror-builder/src/manifestReader.ts`
- Create: `mirror-builder/test/fixtures/manifests/valid-manifest.json`
- Create: `mirror-builder/test/fixtures/manifests/missing-field-manifest.json`
- Test: `mirror-builder/test/manifestReader.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (reads a file path).
- Produces: `PluginMetadata { id: string; name: string; author: string; description: string }`, `ManifestError`, `readManifestMetadata(manifestPath: string): PluginMetadata`.

- [ ] **Step 1: Create fixtures**

`mirror-builder/test/fixtures/manifests/valid-manifest.json`:

```json
{
  "id": "my-plugin-id",
  "name": "My Plugin",
  "version": "1.2.3",
  "minAppVersion": "1.0.0",
  "author": "Some Author",
  "description": "What the plugin does"
}
```

`mirror-builder/test/fixtures/manifests/missing-field-manifest.json`:

```json
{
  "id": "my-plugin-id",
  "name": "My Plugin"
}
```

- [ ] **Step 2: Write the failing tests**

Create `mirror-builder/test/manifestReader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readManifestMetadata, ManifestError } from '../src/manifestReader.js';

const fixture = (name: string) => new URL(`./fixtures/manifests/${name}`, import.meta.url).pathname;

describe('readManifestMetadata', () => {
  it('extracts id/name/author/description from a valid manifest', () => {
    const metadata = readManifestMetadata(fixture('valid-manifest.json'));
    expect(metadata).toEqual({
      id: 'my-plugin-id',
      name: 'My Plugin',
      author: 'Some Author',
      description: 'What the plugin does',
    });
  });

  it('throws ManifestError when the file does not exist', () => {
    expect(() => readManifestMetadata(fixture('does-not-exist.json'))).toThrow(ManifestError);
  });

  it('throws ManifestError when a required field is missing', () => {
    expect(() => readManifestMetadata(fixture('missing-field-manifest.json'))).toThrow(ManifestError);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/manifestReader.test.ts`
Expected: FAIL — `src/manifestReader.ts` does not exist yet.

- [ ] **Step 4: Implement `manifestReader.ts`**

Create `mirror-builder/src/manifestReader.ts`:

```typescript
import { readFileSync } from 'node:fs';

export interface PluginMetadata {
  id: string;
  name: string;
  author: string;
  description: string;
}

export class ManifestError extends Error {}

export function readManifestMetadata(manifestPath: string): PluginMetadata {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    throw new ManifestError(`manifest.json not found at ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestError(`manifest.json at ${manifestPath} is not valid JSON`);
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of ['id', 'name', 'author', 'description'] as const) {
    if (typeof obj[field] !== 'string') {
      throw new ManifestError(`manifest.json at ${manifestPath} is missing required field "${field}"`);
    }
  }
  return {
    id: obj.id as string,
    name: obj.name as string,
    author: obj.author as string,
    description: obj.description as string,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/manifestReader.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/src/manifestReader.ts mirror-builder/test/manifestReader.test.ts mirror-builder/test/fixtures/manifests
git commit -m "feat(mirror-builder): add manifest.json metadata extraction"
```

---

## Task 7: Output writer

**Files:**
- Create: `mirror-builder/src/writer.ts`
- Test: `mirror-builder/test/writer.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VersionEntry { version: string; prerelease: boolean; publishedAt: string; files: string[] }`, `VersionsJson { repo: string; latest: string | null; versions: VersionEntry[] }`, `IndexJsonEntry { id: string; name: string; author: string; description: string; repo: string; latestVersion: string | null; latestPrerelease: string | null }`, `writeVersionsJson(outDir: string, repo: string, data: VersionsJson): void`, `writeIndexJson(outDir: string, entries: IndexJsonEntry[], generatedAt?: string): void`.

- [ ] **Step 1: Write the failing tests**

Create `mirror-builder/test/writer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeVersionsJson, writeIndexJson } from '../src/writer.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mirror-builder-writer-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('writeVersionsJson', () => {
  it('writes versions.json under plugins/<owner>/<repo>/', () => {
    writeVersionsJson(tempDir, 'acme/plugin-one', {
      repo: 'acme/plugin-one',
      latest: '1.0.0',
      versions: [
        { version: '1.0.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ],
    });
    const written = JSON.parse(
      readFileSync(join(tempDir, 'plugins', 'acme', 'plugin-one', 'versions.json'), 'utf-8')
    );
    expect(written.repo).toBe('acme/plugin-one');
    expect(written.latest).toBe('1.0.0');
    expect(written.versions).toHaveLength(1);
  });
});

describe('writeIndexJson', () => {
  it('writes index.json with the given entries and generatedAt', () => {
    writeIndexJson(
      tempDir,
      [
        {
          id: 'my-plugin-id',
          name: 'My Plugin',
          author: 'Some Author',
          description: 'What the plugin does',
          repo: 'acme/plugin-one',
          latestVersion: '1.0.0',
          latestPrerelease: null,
        },
      ],
      '2026-07-23T00:00:00Z'
    );
    const written = JSON.parse(readFileSync(join(tempDir, 'index.json'), 'utf-8'));
    expect(written.generatedAt).toBe('2026-07-23T00:00:00Z');
    expect(written.plugins).toHaveLength(1);
    expect(written.plugins[0].id).toBe('my-plugin-id');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/writer.test.ts`
Expected: FAIL — `src/writer.ts` does not exist yet.

- [ ] **Step 3: Implement `writer.ts`**

Create `mirror-builder/src/writer.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VersionEntry {
  version: string;
  prerelease: boolean;
  publishedAt: string;
  files: string[];
}

export interface VersionsJson {
  repo: string;
  latest: string | null;
  versions: VersionEntry[];
}

export interface IndexJsonEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  latestVersion: string | null;
  latestPrerelease: string | null;
}

export interface IndexJson {
  generatedAt: string;
  plugins: IndexJsonEntry[];
}

export function writeVersionsJson(outDir: string, repo: string, data: VersionsJson): void {
  const pluginDir = join(outDir, 'plugins', repo);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'versions.json'), JSON.stringify(data, null, 2) + '\n');
}

export function writeIndexJson(
  outDir: string,
  entries: IndexJsonEntry[],
  generatedAt: string = new Date().toISOString()
): void {
  mkdirSync(outDir, { recursive: true });
  const index: IndexJson = { generatedAt, plugins: entries };
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/writer.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/src/writer.ts mirror-builder/test/writer.test.ts
git commit -m "feat(mirror-builder): add index.json/versions.json writer"
```

---

## Task 8: CLI orchestration

**Files:**
- Create: `mirror-builder/src/cli.ts`
- Test: `mirror-builder/test/cli.e2e.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`ConfigError`/`PluginConfigEntry` (Task 2), `createGithubClient`/`fetchReleasesForRepos`/`FetchedRelease` (Task 4), `sortReleasesNewestFirst`/`applyRetention` (Task 3), `validateRelease`/`ensureVersionAssets`/`pruneStaleVersionDirs`/`ValidatedVersion` (Task 5), `readManifestMetadata` (Task 6), `writeVersionsJson`/`writeIndexJson`/`VersionEntry`/`IndexJsonEntry` (Task 7).
- Produces: `CliOptions { configPath: string; outDir: string; githubToken?: string }`, `parseArgs(argv: string[]): CliOptions`, `run(options: CliOptions): Promise<number>`.

- [ ] **Step 1: Write the failing end-to-end test**

Create `mirror-builder/test/cli.e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/cli.e2e.test.ts`
Expected: FAIL — `src/cli.ts` does not exist yet.

- [ ] **Step 3: Implement `cli.ts`**

Create `mirror-builder/src/cli.ts`:

```typescript
import { join } from 'node:path';
import { loadConfig, ConfigError, type PluginConfigEntry } from './config.js';
import { createGithubClient, fetchReleasesForRepos, type RepoFetchResult } from './github.js';
import { sortReleasesNewestFirst, applyRetention } from './versionSort.js';
import { validateRelease, ensureVersionAssets, pruneStaleVersionDirs, type ValidatedVersion } from './assets.js';
import { readManifestMetadata } from './manifestReader.js';
import { writeVersionsJson, writeIndexJson, type IndexJsonEntry, type VersionEntry } from './writer.js';

export interface CliOptions {
  configPath: string;
  outDir: string;
  githubToken?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: './tracked-plugins.json',
    outDir: './dist',
    githubToken: process.env.GITHUB_TOKEN,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') options.configPath = argv[++i];
    else if (argv[i] === '--out') options.outDir = argv[++i];
  }
  return options;
}

interface PluginResult {
  entry?: IndexJsonEntry;
  warnings: string[];
}

async function processPlugin(
  entry: PluginConfigEntry,
  defaultRetain: number | 'all',
  releasesResult: RepoFetchResult,
  outDir: string,
  token?: string
): Promise<PluginResult> {
  const warnings: string[] = [];
  if (releasesResult.status === 'error') {
    warnings.push(`Skipping ${entry.repo}: failed to fetch releases (${releasesResult.error.message})`);
    return { warnings };
  }

  const validated: ValidatedVersion[] = [];
  for (const release of releasesResult.releases) {
    const v = validateRelease(release);
    if (!v) {
      warnings.push(`Skipping ${entry.repo}@${release.tagName}: missing required asset (manifest.json/main.js)`);
      continue;
    }
    validated.push(v);
  }

  if (validated.length === 0) {
    warnings.push(`Skipping ${entry.repo}: no valid versions found`);
    return { warnings };
  }

  const sorted = sortReleasesNewestFirst(validated);
  const retain = entry.retain ?? defaultRetain;
  const retained = applyRetention(sorted, retain);

  const pluginDir = join(outDir, 'plugins', entry.repo);
  for (const version of retained) {
    await ensureVersionAssets(pluginDir, version, token);
  }
  pruneStaleVersionDirs(pluginDir, retained.map((v) => v.version));

  const versionEntries: VersionEntry[] = retained.map((v) => ({
    version: v.version,
    prerelease: v.prerelease,
    publishedAt: v.publishedAt,
    files: v.files,
  }));
  const latestStable = retained.find((v) => !v.prerelease) ?? null;
  const latestPrereleaseVersion = retained.find((v) => v.prerelease) ?? null;

  writeVersionsJson(outDir, entry.repo, {
    repo: entry.repo,
    latest: latestStable ? latestStable.version : null,
    versions: versionEntries,
  });

  const metadataSource = latestStable ?? retained[0];
  const manifestPath = join(pluginDir, metadataSource.version, 'manifest.json');
  const metadata = readManifestMetadata(manifestPath);

  return {
    warnings,
    entry: {
      id: metadata.id,
      name: metadata.name,
      author: metadata.author,
      description: metadata.description,
      repo: entry.repo,
      latestVersion: latestStable ? latestStable.version : null,
      latestPrerelease: latestPrereleaseVersion ? latestPrereleaseVersion.version : null,
    },
  };
}

export async function run(options: CliOptions): Promise<number> {
  let config;
  try {
    config = loadConfig(options.configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Fatal: ${error.message}`);
      return 1;
    }
    throw error;
  }

  if (!options.githubToken) {
    console.warn('No GITHUB_TOKEN set — using anonymous GitHub API access (60 requests/hour).');
  }

  const client = createGithubClient(options.githubToken);
  const repos = config.plugins.map((p) => p.repo);
  const releasesByRepo = await fetchReleasesForRepos(client, repos);

  const indexEntries: IndexJsonEntry[] = [];
  const allWarnings: string[] = [];

  for (const plugin of config.plugins) {
    const result = await processPlugin(
      plugin,
      config.defaultRetain,
      releasesByRepo.get(plugin.repo)!,
      options.outDir,
      options.githubToken
    );
    allWarnings.push(...result.warnings);
    if (result.entry) indexEntries.push(result.entry);
  }

  writeIndexJson(options.outDir, indexEntries);

  console.log(`Mirrored ${indexEntries.length}/${config.plugins.length} plugins.`);
  for (const warning of allWarnings) console.warn(`Warning: ${warning}`);

  return 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const exitCode = await run(options);
  process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npx vitest run test/cli.e2e.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Run the full test suite**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npm test`
Expected: PASS — all test files pass (smoke, config, versionSort, github, assets, manifestReader, writer, cli.e2e).

- [ ] **Step 6: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/src/cli.ts mirror-builder/test/cli.e2e.test.ts
git commit -m "feat(mirror-builder): add CLI orchestration with end-to-end test"
```

---

## Task 9: Dockerfile and `build:image` verification

**Files:**
- Create: `mirror-builder/Dockerfile`
- Create: `mirror-builder/tracked-plugins.example.json`
- Create: `mirror-builder/.dockerignore`

**Interfaces:**
- Consumes: the `dist/` directory produced by `npm run generate` (Task 8's `cli.ts`).
- Produces: a runnable `npm run build:image` command.

- [ ] **Step 1: Create the Dockerfile**

Create `mirror-builder/Dockerfile`:

```dockerfile
FROM nginx:alpine
COPY dist/ /usr/share/nginx/html/
```

- [ ] **Step 2: Create `.dockerignore`**

Create `mirror-builder/.dockerignore`:

```
node_modules
test
build
```

- [ ] **Step 3: Create an example tracked-plugins config for manual/documentation use**

Create `mirror-builder/tracked-plugins.example.json`:

```json
{
  "defaultRetain": 5,
  "plugins": [
    { "repo": "owner/repo" }
  ]
}
```

- [ ] **Step 4: Verify the image builds end-to-end with a stub `dist/`**

Run:

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder
mkdir -p dist
echo '{"generatedAt":"2026-07-23T00:00:00Z","plugins":[]}' > dist/index.json
docker build -t obsidian-plugin-mirror-test -f Dockerfile .
```

Expected: `docker build` completes successfully (`Successfully tagged` or equivalent final line).

- [ ] **Step 5: Verify the built image actually serves the file**

Run:

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder
docker run -d --name mirror-test -p 18080:80 obsidian-plugin-mirror-test
sleep 1
curl -s http://localhost:18080/index.json
docker rm -f mirror-test
docker rmi obsidian-plugin-mirror-test
rm -rf dist
```

Expected: `curl` prints `{"generatedAt":"2026-07-23T00:00:00Z","plugins":[]}`.

- [ ] **Step 6: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/Dockerfile mirror-builder/.dockerignore mirror-builder/tracked-plugins.example.json
git commit -m "feat(mirror-builder): add nginx Dockerfile and build:image script"
```

---

## Task 10: `.gitignore` and final full-suite check

**Files:**
- Create: `mirror-builder/.gitignore`

**Interfaces:**
- None — this is a cleanup/verification task.

- [ ] **Step 1: Add a `.gitignore` so build artifacts and dependencies aren't committed**

Create `mirror-builder/.gitignore`:

```
node_modules/
dist/
build/
```

- [ ] **Step 2: Run the full test suite one more time**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/mirror-builder && npm test`
Expected: PASS — every test file passes.

- [ ] **Step 3: Confirm `git status` is clean apart from the intended files**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror && git status`
Expected: working tree clean (no untracked `node_modules`, no leftover `dist/`).

- [ ] **Step 4: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add mirror-builder/.gitignore
git commit -m "chore(mirror-builder): ignore build artifacts and dependencies"
```
