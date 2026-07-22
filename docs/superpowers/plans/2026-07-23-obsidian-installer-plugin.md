# Obsidian Installer Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Obsidian installer plugin (Subsystem B) that browses the mirror's `index.json` registry, installs mirrored plugins into a vault, tracks installed versions independently of Obsidian's own manifest, and checks for/applies updates per the shared format spec's compare rule.

**Architecture:** A standard Obsidian community-plugin project (TypeScript bundled to `main.js` via esbuild) with one focused module per responsibility, matching `docs/superpowers/specs/2026-07-23-obsidian-installer-plugin-design.md`'s module table exactly: `settings.ts`, `registry.ts`, `versionCompare.ts`, `installer.ts`, `updater.ts` are pure/mockable and unit tested with vitest; `main.ts` and `settingsTab.ts` depend on the real Obsidian runtime (`Plugin`, `PluginSettingTab`, `Setting`, `Notice`) and are not unit tested — verified instead by a successful typecheck + esbuild bundle, per the spec's testing strategy.

**Tech Stack:** TypeScript, `esbuild` for bundling to `main.js`, `obsidian` (types-only, external at bundle time), `semver` for version comparison, `vitest` as test runner, `msw` (`msw/node`) for HTTP mocking of the mirror's `index.json`/`versions.json` endpoints.

## Global Constraints

- JSON schemas (`index.json`, `versions.json`) and the semver-with-fallback compare rule must match `docs/superpowers/specs/2026-07-23-mirror-format-design.md` exactly — this is the contract with Subsystem A (`mirror-builder`).
- The installer never talks to GitHub — only to the configured `mirrorBaseUrl`.
- `trackedPlugins` (id → `{ repo, installedVersion, allowPrerelease }`) is this plugin's own bookkeeping, persisted via `loadData`/`saveData`, independent of the installed plugin's own `manifest.json`.
- One plugin's failure (network error, 404, disk error) must never stop the rest of a browse-list render or update-check batch from completing.
- Update candidate selection must respect each tracked plugin's own `allowPrerelease` flag; on first install (not yet tracked), prereleases are never selected.
- `autoCheckOnStartup` and `autoInstallUpdates` are independently toggleable; when auto-install is off, an available update is surfaced with a manual Install button instead.
- All source lives under `obsidian-installer-plugin/` at the repo root, sibling to `mirror-builder/`, with its own independent toolchain (esbuild, not tsx/Node-CLI).
- `main.ts` and `settingsTab.ts` are not unit tested (Obsidian's runtime classes can't be meaningfully instantiated outside the app) — verified via `tsc --noEmit` and a successful `esbuild` bundle instead.

---

## Task 1: Project scaffolding

**Files:**
- Create: `obsidian-installer-plugin/package.json`
- Create: `obsidian-installer-plugin/tsconfig.json`
- Create: `obsidian-installer-plugin/esbuild.config.mjs`
- Create: `obsidian-installer-plugin/vitest.config.ts`
- Create: `obsidian-installer-plugin/manifest.json`
- Create: `obsidian-installer-plugin/versions.json`
- Create: `obsidian-installer-plugin/.gitignore`
- Create: `obsidian-installer-plugin/src/smoke.ts`
- Test: `obsidian-installer-plugin/test/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm test`, `npm run typecheck`, and `npm run build` (esbuild bundle to `main.js`) toolchain that every later task builds on.

- [ ] **Step 1: Create the package directory and initialize `package.json`**

```bash
mkdir -p /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin/src
mkdir -p /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin/test
cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin
npm init -y
```

- [ ] **Step 2: Set `package.json` scripts**

Edit `obsidian-installer-plugin/package.json` so it looks like this (keep npm-generated `name`/`version`, just add/overwrite these fields):

```json
{
  "name": "obsidian-installer-plugin",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc --noEmit && node esbuild.config.mjs production",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Install dependencies**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin
npm install semver
npm install --save-dev typescript esbuild vitest msw obsidian @types/node @types/semver
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES2018",
    "allowJs": true,
    "noImplicitAny": true,
    "moduleResolution": "Bundler",
    "importHelpers": true,
    "isolatedModules": true,
    "strict": true,
    "skipLibCheck": true,
    "lib": ["DOM", "ES2018"],
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 5: Create `esbuild.config.mjs`**

```javascript
import esbuild from 'esbuild';
import process from 'node:process';

const banner = '/* THIS IS A GENERATED/BUNDLED FILE BY ESBUILD. */';

const prod = process.argv.includes('production');

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
  ],
  format: 'cjs',
  target: 'es2020',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  outfile: 'main.js',
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
```

- [ ] **Step 6: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 7: Create the plugin's own Obsidian `manifest.json` and `versions.json`**

`obsidian-installer-plugin/manifest.json`:

```json
{
  "id": "obsidian-mirror-installer",
  "name": "Mirror Installer",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "Browse, install, and update beta plugins mirrored on an internal nginx server, for use inside networks without GitHub access.",
  "author": "khchiang1121",
  "isDesktopOnly": false
}
```

`obsidian-installer-plugin/versions.json`:

```json
{
  "1.0.0": "1.0.0"
}
```

- [ ] **Step 8: Create `.gitignore`**

```
node_modules/
main.js
*.js.map
```

- [ ] **Step 9: Write a smoke test to validate the toolchain end-to-end**

Create `obsidian-installer-plugin/src/smoke.ts`:

```typescript
export function add(a: number, b: number): number {
  return a + b;
}
```

Create `obsidian-installer-plugin/test/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { add } from '../src/smoke';

describe('toolchain smoke test', () => {
  it('runs a basic TS test through vitest', () => {
    expect(add(2, 3)).toBe(5);
  });
});
```

- [ ] **Step 10: Run the test to confirm the toolchain works**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npm test`
Expected: 1 test passes.

- [ ] **Step 11: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add obsidian-installer-plugin/package.json obsidian-installer-plugin/package-lock.json \
  obsidian-installer-plugin/tsconfig.json obsidian-installer-plugin/esbuild.config.mjs \
  obsidian-installer-plugin/vitest.config.ts obsidian-installer-plugin/manifest.json \
  obsidian-installer-plugin/versions.json obsidian-installer-plugin/.gitignore \
  obsidian-installer-plugin/src/smoke.ts obsidian-installer-plugin/test/smoke.test.ts
git commit -m "chore: scaffold obsidian-installer-plugin TS project"
```

---

## Task 2: Settings data model

**Files:**
- Create: `obsidian-installer-plugin/src/settings.ts`
- Test: `obsidian-installer-plugin/test/settings.test.ts`

**Interfaces:**
- Produces: `TrackedPlugin { repo: string; installedVersion: string; allowPrerelease: boolean }`, `PluginSettings { mirrorBaseUrl: string; autoCheckOnStartup: boolean; autoInstallUpdates: boolean; trackedPlugins: Record<string, TrackedPlugin> }`, `DEFAULT_SETTINGS: PluginSettings`, `mergeSettings(loaded: Partial<PluginSettings> | null | undefined): PluginSettings`.

- [ ] **Step 1: Write the failing tests**

Create `obsidian-installer-plugin/test/settings.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mergeSettings, DEFAULT_SETTINGS } from '../src/settings';

describe('mergeSettings', () => {
  it('returns defaults when nothing was loaded', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('overrides only the fields present in the loaded data', () => {
    const merged = mergeSettings({ mirrorBaseUrl: 'https://plugins.internal.example.com/' });
    expect(merged.mirrorBaseUrl).toBe('https://plugins.internal.example.com/');
    expect(merged.autoCheckOnStartup).toBe(DEFAULT_SETTINGS.autoCheckOnStartup);
    expect(merged.autoInstallUpdates).toBe(DEFAULT_SETTINGS.autoInstallUpdates);
  });

  it('preserves loaded trackedPlugins entries', () => {
    const merged = mergeSettings({
      trackedPlugins: {
        'my-plugin-id': { repo: 'acme/my-plugin', installedVersion: '1.0.0', allowPrerelease: true },
      },
    });
    expect(merged.trackedPlugins['my-plugin-id']).toEqual({
      repo: 'acme/my-plugin',
      installedVersion: '1.0.0',
      allowPrerelease: true,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/settings.test.ts`
Expected: FAIL — `src/settings.ts` does not exist yet.

- [ ] **Step 3: Implement `settings.ts`**

Create `obsidian-installer-plugin/src/settings.ts`:

```typescript
export interface TrackedPlugin {
  repo: string;
  installedVersion: string;
  allowPrerelease: boolean;
}

export interface PluginSettings {
  mirrorBaseUrl: string;
  autoCheckOnStartup: boolean;
  autoInstallUpdates: boolean;
  trackedPlugins: Record<string, TrackedPlugin>;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  mirrorBaseUrl: '',
  autoCheckOnStartup: true,
  autoInstallUpdates: true,
  trackedPlugins: {},
};

export function mergeSettings(loaded: Partial<PluginSettings> | null | undefined): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...loaded,
    trackedPlugins: {
      ...DEFAULT_SETTINGS.trackedPlugins,
      ...(loaded?.trackedPlugins ?? {}),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/settings.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add obsidian-installer-plugin/src/settings.ts obsidian-installer-plugin/test/settings.test.ts
git commit -m "feat(obsidian-installer-plugin): add settings data model"
```

---

## Task 3: Version compare & candidate selection

**Files:**
- Create: `obsidian-installer-plugin/src/versionCompare.ts`
- Test: `obsidian-installer-plugin/test/versionCompare.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VersionCandidate { version: string; prerelease: boolean; publishedAt: string }`, `compareVersionsNewestFirst(a, b): number`, `sortVersionsNewestFirst<T extends VersionCandidate>(versions: T[]): T[]`, `selectUpdateCandidate<T extends VersionCandidate>(versions: T[], allowPrerelease: boolean): T | null`, `isNewerThanInstalled(candidate: VersionCandidate, installedVersion: string, allVersions: VersionCandidate[]): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `obsidian-installer-plugin/test/versionCompare.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  sortVersionsNewestFirst,
  selectUpdateCandidate,
  isNewerThanInstalled,
  type VersionCandidate,
} from '../src/versionCompare';

function candidate(version: string, publishedAt: string, prerelease = false): VersionCandidate {
  return { version, publishedAt, prerelease };
}

describe('sortVersionsNewestFirst', () => {
  it('sorts valid semver tags newest-first by semver value', () => {
    const input = [candidate('1.0.0', '2026-01-01T00:00:00Z'), candidate('2.1.0', '2026-02-01T00:00:00Z')];
    expect(sortVersionsNewestFirst(input).map((v) => v.version)).toEqual(['2.1.0', '1.0.0']);
  });

  it('falls back to publishedAt when tags are not valid semver', () => {
    const input = [candidate('release-a', '2026-01-01T00:00:00Z'), candidate('release-b', '2026-03-01T00:00:00Z')];
    expect(sortVersionsNewestFirst(input).map((v) => v.version)).toEqual(['release-b', 'release-a']);
  });
});

describe('selectUpdateCandidate', () => {
  it('excludes prereleases when allowPrerelease is false', () => {
    const input = [
      candidate('2.0.0-beta.1', '2026-03-01T00:00:00Z', true),
      candidate('1.5.0', '2026-02-01T00:00:00Z', false),
    ];
    expect(selectUpdateCandidate(input, false)?.version).toBe('1.5.0');
  });

  it('includes prereleases when allowPrerelease is true, picking the newest overall', () => {
    const input = [
      candidate('2.0.0-beta.1', '2026-03-01T00:00:00Z', true),
      candidate('1.5.0', '2026-02-01T00:00:00Z', false),
    ];
    expect(selectUpdateCandidate(input, true)?.version).toBe('2.0.0-beta.1');
  });

  it('returns null when there are no eligible versions', () => {
    const input = [candidate('2.0.0-beta.1', '2026-03-01T00:00:00Z', true)];
    expect(selectUpdateCandidate(input, false)).toBeNull();
  });
});

describe('isNewerThanInstalled', () => {
  const all = [
    candidate('2.0.0', '2026-03-01T00:00:00Z'),
    candidate('1.5.0', '2026-02-01T00:00:00Z'),
    candidate('1.0.0', '2026-01-01T00:00:00Z'),
  ];

  it('is true when the candidate is newer than the installed version', () => {
    expect(isNewerThanInstalled(all[0], '1.5.0', all)).toBe(true);
  });

  it('is false when the candidate is the same as the installed version', () => {
    expect(isNewerThanInstalled(all[1], '1.5.0', all)).toBe(false);
  });

  it('is false when the candidate is older than the installed version', () => {
    expect(isNewerThanInstalled(all[2], '1.5.0', all)).toBe(false);
  });

  it('is true when the installed version is no longer in the list (pruned upstream)', () => {
    expect(isNewerThanInstalled(all[0], '0.9.0', all)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/versionCompare.test.ts`
Expected: FAIL — `src/versionCompare.ts` does not exist yet.

- [ ] **Step 3: Implement `versionCompare.ts`**

Create `obsidian-installer-plugin/src/versionCompare.ts`:

```typescript
import semver from 'semver';

export interface VersionCandidate {
  version: string;
  prerelease: boolean;
  publishedAt: string;
}

function parseSemver(tag: string): string | null {
  const coerced = semver.coerce(tag);
  if (!coerced) return null;
  return semver.valid(coerced) ? coerced.version : null;
}

export function compareVersionsNewestFirst(a: VersionCandidate, b: VersionCandidate): number {
  const aVer = parseSemver(a.version);
  const bVer = parseSemver(b.version);
  if (aVer && bVer) {
    return semver.compare(bVer, aVer);
  }
  return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
}

export function sortVersionsNewestFirst<T extends VersionCandidate>(versions: T[]): T[] {
  return [...versions].sort(compareVersionsNewestFirst);
}

export function selectUpdateCandidate<T extends VersionCandidate>(
  versions: T[],
  allowPrerelease: boolean
): T | null {
  const eligible = versions.filter((v) => allowPrerelease || !v.prerelease);
  if (eligible.length === 0) return null;
  return sortVersionsNewestFirst(eligible)[0];
}

export function isNewerThanInstalled(
  candidate: VersionCandidate,
  installedVersion: string,
  allVersions: VersionCandidate[]
): boolean {
  if (candidate.version === installedVersion) return false;
  const installedEntry = allVersions.find((v) => v.version === installedVersion);
  if (!installedEntry) return true;
  return compareVersionsNewestFirst(candidate, installedEntry) < 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/versionCompare.test.ts`
Expected: PASS — 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add obsidian-installer-plugin/src/versionCompare.ts obsidian-installer-plugin/test/versionCompare.test.ts
git commit -m "feat(obsidian-installer-plugin): add semver-with-fallback compare and candidate selection"
```

---

## Task 4: Registry fetching

**Files:**
- Create: `obsidian-installer-plugin/src/registry.ts`
- Test: `obsidian-installer-plugin/test/registry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RegistryEntry { id: string; name: string; author: string; description: string; repo: string; latestVersion: string | null; latestPrerelease: string | null }`, `RegistryIndex { generatedAt: string; plugins: RegistryEntry[] }`, `VersionEntry { version: string; prerelease: boolean; publishedAt: string; files: string[] }`, `VersionsData { repo: string; latest: string | null; versions: VersionEntry[] }`, `RegistryError`, `fetchIndex(mirrorBaseUrl: string, fetchFn?: typeof fetch): Promise<RegistryIndex>`, `fetchVersions(mirrorBaseUrl: string, repo: string, fetchFn?: typeof fetch): Promise<VersionsData>`.

- [ ] **Step 1: Write the failing tests**

Create `obsidian-installer-plugin/test/registry.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/registry.test.ts`
Expected: FAIL — `src/registry.ts` does not exist yet.

- [ ] **Step 3: Implement `registry.ts`**

Create `obsidian-installer-plugin/src/registry.ts`:

```typescript
export interface RegistryEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  latestVersion: string | null;
  latestPrerelease: string | null;
}

export interface RegistryIndex {
  generatedAt: string;
  plugins: RegistryEntry[];
}

export interface VersionEntry {
  version: string;
  prerelease: boolean;
  publishedAt: string;
  files: string[];
}

export interface VersionsData {
  repo: string;
  latest: string | null;
  versions: VersionEntry[];
}

export class RegistryError extends Error {}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function fetchIndex(mirrorBaseUrl: string, fetchFn: typeof fetch = fetch): Promise<RegistryIndex> {
  const url = `${trimTrailingSlash(mirrorBaseUrl)}/index.json`;
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new RegistryError(`Failed to fetch registry index from ${url}: ${response.status}`);
  }
  return (await response.json()) as RegistryIndex;
}

export async function fetchVersions(
  mirrorBaseUrl: string,
  repo: string,
  fetchFn: typeof fetch = fetch
): Promise<VersionsData> {
  const url = `${trimTrailingSlash(mirrorBaseUrl)}/plugins/${repo}/versions.json`;
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new RegistryError(`Failed to fetch versions.json for ${repo} from ${url}: ${response.status}`);
  }
  return (await response.json()) as VersionsData;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/registry.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add obsidian-installer-plugin/src/registry.ts obsidian-installer-plugin/test/registry.test.ts
git commit -m "feat(obsidian-installer-plugin): add registry (index.json/versions.json) fetching"
```

---

## Task 5: Installer (install + remove)

**Files:**
- Create: `obsidian-installer-plugin/src/installer.ts`
- Test: `obsidian-installer-plugin/test/installer.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (works against injected fake adapter/plugin-manager in tests; against real Obsidian objects cast to these interfaces in `main.ts`/`settingsTab.ts`).
- Produces: `VaultAdapterLike { mkdir(path): Promise<void>; write(path, data): Promise<void>; rmdir(path, recursive): Promise<void> }`, `PluginManagerLike { enablePlugin(id): Promise<void>; disablePlugin(id): Promise<void> }`, `InstallableVersion { repo: string; version: string; files: string[] }`, `installPluginVersion(adapter, pluginManager, mirrorBaseUrl, pluginId, version, fetchFn?): Promise<void>`, `removePlugin(adapter, pluginManager, pluginId): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `obsidian-installer-plugin/test/installer.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/installer.test.ts`
Expected: FAIL — `src/installer.ts` does not exist yet.

- [ ] **Step 3: Implement `installer.ts`**

Create `obsidian-installer-plugin/src/installer.ts`:

```typescript
export interface VaultAdapterLike {
  mkdir(path: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

export interface PluginManagerLike {
  enablePlugin(id: string): Promise<void>;
  disablePlugin(id: string): Promise<void>;
}

export interface InstallableVersion {
  repo: string;
  version: string;
  files: string[];
}

export async function installPluginVersion(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
  mirrorBaseUrl: string,
  pluginId: string,
  version: InstallableVersion,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const pluginDir = `.obsidian/plugins/${pluginId}`;
  try {
    await adapter.mkdir(pluginDir);
  } catch {
    // Directory already exists (re-install/update) — fine.
  }

  const base = mirrorBaseUrl.replace(/\/+$/, '');
  for (const file of version.files) {
    const url = `${base}/plugins/${version.repo}/${version.version}/${file}`;
    const response = await fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status}`);
    }
    const content = await response.text();
    await adapter.write(`${pluginDir}/${file}`, content);
  }

  await pluginManager.enablePlugin(pluginId);
}

export async function removePlugin(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
  pluginId: string
): Promise<void> {
  await pluginManager.disablePlugin(pluginId);
  await adapter.rmdir(`.obsidian/plugins/${pluginId}`, true);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/installer.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add obsidian-installer-plugin/src/installer.ts obsidian-installer-plugin/test/installer.test.ts
git commit -m "feat(obsidian-installer-plugin): add plugin install/remove against injected vault adapter"
```

---

## Task 6: Update checking and applying

**Files:**
- Create: `obsidian-installer-plugin/src/updater.ts`
- Test: `obsidian-installer-plugin/test/updater.test.ts`

**Interfaces:**
- Consumes: `fetchVersions`/`VersionsData`/`VersionEntry` (Task 4, `registry.ts`), `sortVersionsNewestFirst`/`selectUpdateCandidate`/`isNewerThanInstalled` (Task 3, `versionCompare.ts`), `installPluginVersion`/`VaultAdapterLike`/`PluginManagerLike` (Task 5, `installer.ts`), `TrackedPlugin` (Task 2, `settings.ts`).
- Produces: `UpdateCheckResult { pluginId: string; status: 'up-to-date' | 'update-available' | 'error'; candidate?: VersionEntry; error?: string }`, `checkForUpdates(mirrorBaseUrl: string, trackedPlugins: Record<string, TrackedPlugin>, fetchFn?: typeof fetch): Promise<UpdateCheckResult[]>`, `applyUpdate(adapter, pluginManager, mirrorBaseUrl, pluginId, repo, candidate, fetchFn?): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `obsidian-installer-plugin/test/updater.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/updater.test.ts`
Expected: FAIL — `src/updater.ts` does not exist yet.

- [ ] **Step 3: Implement `updater.ts`**

Create `obsidian-installer-plugin/src/updater.ts`:

```typescript
import { fetchVersions, type VersionEntry } from './registry';
import { sortVersionsNewestFirst, selectUpdateCandidate, isNewerThanInstalled } from './versionCompare';
import { installPluginVersion, type VaultAdapterLike, type PluginManagerLike } from './installer';
import type { TrackedPlugin } from './settings';

export interface UpdateCheckResult {
  pluginId: string;
  status: 'up-to-date' | 'update-available' | 'error';
  candidate?: VersionEntry;
  error?: string;
}

export async function checkForUpdates(
  mirrorBaseUrl: string,
  trackedPlugins: Record<string, TrackedPlugin>,
  fetchFn: typeof fetch = fetch
): Promise<UpdateCheckResult[]> {
  const results: UpdateCheckResult[] = [];

  for (const [pluginId, tracked] of Object.entries(trackedPlugins)) {
    try {
      const data = await fetchVersions(mirrorBaseUrl, tracked.repo, fetchFn);
      const sorted = sortVersionsNewestFirst(data.versions);
      const candidate = selectUpdateCandidate(sorted, tracked.allowPrerelease);

      if (!candidate || !isNewerThanInstalled(candidate, tracked.installedVersion, sorted)) {
        results.push({ pluginId, status: 'up-to-date' });
        continue;
      }

      results.push({ pluginId, status: 'update-available', candidate });
    } catch (error) {
      results.push({ pluginId, status: 'error', error: (error as Error).message });
    }
  }

  return results;
}

export async function applyUpdate(
  adapter: VaultAdapterLike,
  pluginManager: PluginManagerLike,
  mirrorBaseUrl: string,
  pluginId: string,
  repo: string,
  candidate: VersionEntry,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  await installPluginVersion(
    adapter,
    pluginManager,
    mirrorBaseUrl,
    pluginId,
    { repo, version: candidate.version, files: candidate.files },
    fetchFn
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npx vitest run test/updater.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Run the full test suite**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npm test`
Expected: PASS — all test files pass (smoke, settings, versionCompare, registry, installer, updater).

- [ ] **Step 6: Commit**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add obsidian-installer-plugin/src/updater.ts obsidian-installer-plugin/test/updater.test.ts
git commit -m "feat(obsidian-installer-plugin): add update checking and applying"
```

---

## Task 7: Settings tab UI

**Files:**
- Create: `obsidian-installer-plugin/src/settingsTab.ts`

**Interfaces:**
- Consumes: `fetchIndex`/`fetchVersions`/`RegistryEntry` (Task 4), `sortVersionsNewestFirst`/`selectUpdateCandidate` (Task 3), `installPluginVersion`/`removePlugin`/`VaultAdapterLike`/`PluginManagerLike` (Task 5), and (type-only) `MirrorInstallerPlugin` from `main.ts` (Task 8 — this is a forward reference resolved when Task 8 creates `main.ts`; TypeScript allows this via `import type` with no runtime dependency).
- Produces: `MirrorInstallerSettingTab` (extends Obsidian's `PluginSettingTab`), rendering: mirror URL field, startup/auto-install toggles, a manual "Check now" button, the installed-plugins list (per-plugin prerelease toggle + conditional "Install update" button + Remove button), and the registry browse list (Install button per not-yet-tracked entry).
- **Not unit tested** — Obsidian's `Setting`/DOM APIs aren't meaningfully testable outside the app (per the design's testing strategy). Verified via the typecheck + build steps in Task 8, and manually in a real vault.

- [ ] **Step 1: Implement `settingsTab.ts`**

Create `obsidian-installer-plugin/src/settingsTab.ts`:

```typescript
import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type MirrorInstallerPlugin from './main';
import { fetchIndex, fetchVersions, type RegistryEntry } from './registry';
import { sortVersionsNewestFirst, selectUpdateCandidate } from './versionCompare';
import { installPluginVersion, removePlugin, type VaultAdapterLike, type PluginManagerLike } from './installer';

export class MirrorInstallerSettingTab extends PluginSettingTab {
  plugin: MirrorInstallerPlugin;

  constructor(app: App, plugin: MirrorInstallerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private getAdapter(): VaultAdapterLike {
    return this.app.vault.adapter as unknown as VaultAdapterLike;
  }

  private getPluginManager(): PluginManagerLike {
    return (this.app as unknown as { plugins: PluginManagerLike }).plugins;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Mirror base URL')
      .setDesc('Internal nginx server hosting the plugin mirror.')
      .addText((text) =>
        text.setValue(this.plugin.settings.mirrorBaseUrl).onChange(async (value) => {
          this.plugin.settings.mirrorBaseUrl = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Check for updates on startup')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoCheckOnStartup).onChange(async (value) => {
          this.plugin.settings.autoCheckOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Install updates automatically')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoInstallUpdates).onChange(async (value) => {
          this.plugin.settings.autoInstallUpdates = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Check for updates now')
      .addButton((button) =>
        button.setButtonText('Check now').onClick(async () => {
          await this.plugin.runUpdateCheck();
          this.display();
        })
      );

    containerEl.createEl('h3', { text: 'Installed mirrored plugins' });
    this.renderInstalledPlugins(containerEl);

    containerEl.createEl('h3', { text: 'Available in mirror' });
    void this.renderRegistry(containerEl);
  }

  private renderInstalledPlugins(containerEl: HTMLElement): void {
    const tracked = this.plugin.settings.trackedPlugins;
    const ids = Object.keys(tracked);
    if (ids.length === 0) {
      containerEl.createEl('p', { text: 'No mirrored plugins installed yet.' });
      return;
    }

    for (const id of ids) {
      const entry = tracked[id];
      const pending = this.plugin.pendingUpdates.get(id);
      const setting = new Setting(containerEl)
        .setName(id)
        .setDesc(
          pending?.candidate
            ? `Installed v${entry.installedVersion} — update available: v${pending.candidate.version}`
            : `Installed v${entry.installedVersion}`
        );

      if (pending?.candidate) {
        const candidate = pending.candidate;
        setting.addButton((button) =>
          button.setButtonText('Install update').onClick(async () => {
            try {
              await installPluginVersion(
                this.getAdapter(),
                this.getPluginManager(),
                this.plugin.settings.mirrorBaseUrl,
                id,
                { repo: entry.repo, version: candidate.version, files: candidate.files },
                fetch
              );
              entry.installedVersion = candidate.version;
              this.plugin.pendingUpdates.delete(id);
              await this.plugin.saveSettings();
              new Notice(`Updated ${id} to v${entry.installedVersion}`);
              this.display();
            } catch (error) {
              new Notice(`Failed to update ${id}: ${(error as Error).message}`);
            }
          })
        );
      }

      setting.addToggle((toggle) =>
        toggle
          .setValue(entry.allowPrerelease)
          .setTooltip('Allow prerelease versions')
          .onChange(async (value) => {
            entry.allowPrerelease = value;
            await this.plugin.saveSettings();
          })
      );

      setting.addButton((button) =>
        button.setButtonText('Remove').onClick(async () => {
          try {
            await removePlugin(this.getAdapter(), this.getPluginManager(), id);
            delete this.plugin.settings.trackedPlugins[id];
            this.plugin.pendingUpdates.delete(id);
            await this.plugin.saveSettings();
            new Notice(`Removed ${id}`);
            this.display();
          } catch (error) {
            new Notice(`Failed to remove ${id}: ${(error as Error).message}`);
          }
        })
      );
    }
  }

  private async renderRegistry(containerEl: HTMLElement): Promise<void> {
    let entries: RegistryEntry[];
    try {
      const index = await fetchIndex(this.plugin.settings.mirrorBaseUrl, fetch);
      entries = index.plugins;
    } catch (error) {
      containerEl.createEl('p', { text: `Failed to load registry: ${(error as Error).message}` });
      return;
    }

    for (const entry of entries) {
      if (this.plugin.settings.trackedPlugins[entry.id]) continue;

      new Setting(containerEl)
        .setName(entry.name)
        .setDesc(`${entry.description} — by ${entry.author} — latest v${entry.latestVersion ?? 'n/a'}`)
        .addButton((button) =>
          button.setButtonText('Install').onClick(async () => {
            try {
              const versions = await fetchVersions(this.plugin.settings.mirrorBaseUrl, entry.repo, fetch);
              const sorted = sortVersionsNewestFirst(versions.versions);
              const candidate = selectUpdateCandidate(sorted, false);
              if (!candidate) {
                new Notice(`No installable version found for ${entry.name}`);
                return;
              }
              await installPluginVersion(
                this.getAdapter(),
                this.getPluginManager(),
                this.plugin.settings.mirrorBaseUrl,
                entry.id,
                { repo: entry.repo, version: candidate.version, files: candidate.files },
                fetch
              );
              this.plugin.settings.trackedPlugins[entry.id] = {
                repo: entry.repo,
                installedVersion: candidate.version,
                allowPrerelease: false,
              };
              await this.plugin.saveSettings();
              new Notice(`Installed ${entry.name} v${candidate.version}`);
              this.display();
            } catch (error) {
              new Notice(`Failed to install ${entry.name}: ${(error as Error).message}`);
            }
          })
        );
    }
  }
}
```

- [ ] **Step 2: Commit** (bundled with Task 8, since `settingsTab.ts` imports a type from `main.ts` which doesn't exist yet — committing both together keeps the tree buildable at every commit)

No commit here; proceed directly to Task 8.

---

## Task 8: Plugin entry point and build verification

**Files:**
- Create: `obsidian-installer-plugin/src/main.ts`

**Interfaces:**
- Consumes: `mergeSettings`/`PluginSettings` (Task 2), `checkForUpdates`/`applyUpdate`/`UpdateCheckResult` (Task 6), `MirrorInstallerSettingTab` (Task 7), `VaultAdapterLike`/`PluginManagerLike` (Task 5).
- Produces: `MirrorInstallerPlugin` (default export, extends Obsidian's `Plugin`) with `settings: PluginSettings`, `pendingUpdates: Map<string, UpdateCheckResult>`, `saveSettings(): Promise<void>`, `runUpdateCheck(): Promise<void>`.
- **Not unit tested** — extends Obsidian's `Plugin` class, which requires a real Obsidian `App` to construct. Verified via `npm run typecheck` and `npm run build` (esbuild bundle) below.

- [ ] **Step 1: Implement `main.ts`**

Create `obsidian-installer-plugin/src/main.ts`:

```typescript
import { Notice, Plugin } from 'obsidian';
import { mergeSettings, type PluginSettings } from './settings';
import { checkForUpdates, applyUpdate, type UpdateCheckResult } from './updater';
import { MirrorInstallerSettingTab } from './settingsTab';
import type { VaultAdapterLike, PluginManagerLike } from './installer';

export default class MirrorInstallerPlugin extends Plugin {
  settings!: PluginSettings;
  pendingUpdates: Map<string, UpdateCheckResult> = new Map();

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    this.addSettingTab(new MirrorInstallerSettingTab(this.app, this));

    this.addCommand({
      id: 'check-for-mirror-plugin-updates',
      name: 'Check for mirrored plugin updates',
      callback: () => {
        void this.runUpdateCheck();
      },
    });

    if (this.settings.autoCheckOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        void this.runUpdateCheck();
      });
    }
  }

  onunload(): void {
    // addCommand/addSettingTab registrations are cleaned up automatically by Obsidian;
    // nothing else is registered outside the plugin lifecycle, so there is nothing to tear down here.
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private getAdapter(): VaultAdapterLike {
    return this.app.vault.adapter as unknown as VaultAdapterLike;
  }

  private getPluginManager(): PluginManagerLike {
    return (this.app as unknown as { plugins: PluginManagerLike }).plugins;
  }

  async runUpdateCheck(): Promise<void> {
    const results = await checkForUpdates(this.settings.mirrorBaseUrl, this.settings.trackedPlugins, fetch);
    const updatesAvailable = results.filter((r) => r.status === 'update-available');
    const errors = results.filter((r) => r.status === 'error');

    this.pendingUpdates.clear();
    for (const result of updatesAvailable) {
      this.pendingUpdates.set(result.pluginId, result);
    }

    if (this.settings.autoInstallUpdates && updatesAvailable.length > 0) {
      const installedIds: string[] = [];
      for (const result of updatesAvailable) {
        if (!result.candidate) continue;
        const tracked = this.settings.trackedPlugins[result.pluginId];
        try {
          await applyUpdate(
            this.getAdapter(),
            this.getPluginManager(),
            this.settings.mirrorBaseUrl,
            result.pluginId,
            tracked.repo,
            result.candidate,
            fetch
          );
          tracked.installedVersion = result.candidate.version;
          installedIds.push(result.pluginId);
          this.pendingUpdates.delete(result.pluginId);
        } catch (error) {
          console.error(`Failed to auto-install update for ${result.pluginId}`, error);
        }
      }
      if (installedIds.length > 0) {
        await this.saveSettings();
        new Notice(`Updated ${installedIds.length} mirrored plugin(s): ${installedIds.join(', ')}`);
      }
    }

    for (const errorResult of errors) {
      console.error(`Update check failed for ${errorResult.pluginId}: ${errorResult.error}`);
    }
  }
}
```

- [ ] **Step 2: Run the typecheck**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npm run typecheck`
Expected: no type errors reported.

- [ ] **Step 3: Run the production build**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && node esbuild.config.mjs production`
Expected: esbuild reports success and `main.js` is created in `obsidian-installer-plugin/`.

- [ ] **Step 4: Run the full test suite once more**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npm test`
Expected: PASS — all 6 test files pass (smoke, settings, versionCompare, registry, installer, updater); `main.ts`/`settingsTab.ts` have no test files by design.

- [ ] **Step 5: Commit `settingsTab.ts` and `main.ts` together**

```bash
cd /home/neverleave0916/workspace/obsidian-plugin-mirror
git add obsidian-installer-plugin/src/settingsTab.ts obsidian-installer-plugin/src/main.ts
git commit -m "feat(obsidian-installer-plugin): add settings tab UI and plugin entry point"
```

---

## Task 9: Final full-suite check

**Files:**
- None (verification only).

**Interfaces:**
- None.

- [ ] **Step 1: Run the full test suite**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npm test`
Expected: PASS — every test file passes.

- [ ] **Step 2: Run the typecheck and build once more against the final tree**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror/obsidian-installer-plugin && npm run typecheck && node esbuild.config.mjs production`
Expected: no type errors; `main.js` builds successfully.

- [ ] **Step 3: Confirm `git status` is clean apart from the intended files**

Run: `cd /home/neverleave0916/workspace/obsidian-plugin-mirror && git status`
Expected: working tree clean (no untracked `node_modules`, no leftover `main.js` — it's gitignored).
