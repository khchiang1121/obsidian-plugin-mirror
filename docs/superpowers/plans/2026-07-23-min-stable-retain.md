# Minimum Stable Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `defaultMinStableRetain`/`minStableRetain` config option so a burst of prerelease versions can never crowd every stable version out of a plugin's retained set.

**Architecture:** Extend the existing `retain`/`defaultRetain` config pattern with a parallel, optional `minStableRetain` setting. `applyRetention` in `versionSort.ts` gains a third parameter: after taking the top-`retain` newest-first window, if it contains fewer than `minStableRetain` non-prerelease entries, walk further back through the sorted list to pull in additional stable entries, then re-merge and re-sort newest-first. `cli.ts` resolves and threads the new setting exactly like it already does for `retain`.

**Tech Stack:** TypeScript, Vitest, existing `mirror-builder` package (`src/config.ts`, `src/versionSort.ts`, `src/cli.ts`).

## Global Constraints

- `defaultMinStableRetain` and per-plugin `minStableRetain` are **optional**; when absent, default to `0` (no floor) — existing config files (including `mirror-builder/tracked-plugins.json`) must keep validating and behaving exactly as before.
- Valid values: non-negative integer (`0` allowed). Unlike `retain`, `"all"` is not a valid value for this setting.
- When the floor pulls in extra versions, the final retained list must still be sorted newest-first (reuse `compareReleasesNewestFirst` from `versionSort.ts`), and total size may exceed `retain`.
- `retain: 'all'` makes the floor a no-op (everything is already retained).

---

### Task 1: Config parsing for `minStableRetain`

**Files:**
- Modify: `mirror-builder/src/config.ts`
- Test: `mirror-builder/test/config.test.ts`
- Create fixture: `mirror-builder/test/fixtures/config/invalid-min-stable-retain.json`
- Modify fixture: `mirror-builder/test/fixtures/config/valid.json`

**Interfaces:**
- Produces: `TrackedPluginsConfig.defaultMinStableRetain: number` (always present after `loadConfig`, defaults to `0`).
- Produces: `PluginConfigEntry.minStableRetain?: number` (per-plugin override, `undefined` when not set in the source file).

- [ ] **Step 1: Write the failing tests**

Add to `mirror-builder/test/config.test.ts` (inside the existing `describe('loadConfig', ...)` block, after the `'parses a valid config file'` test):

```ts
  it('defaults defaultMinStableRetain to 0 and parses per-plugin minStableRetain', () => {
    const config = loadConfig(fixture('valid.json'));
    expect(config.defaultMinStableRetain).toBe(0);
    expect(config.plugins).toEqual([
      { repo: 'acme/plugin-one', retain: undefined, minStableRetain: undefined },
      { repo: 'acme/plugin-two', retain: 10, minStableRetain: 3 },
      { repo: 'acme/plugin-three', retain: 'all', minStableRetain: undefined },
    ]);
  });

  it('parses an explicit defaultMinStableRetain', () => {
    const config = loadConfig(fixture('valid-with-min-stable-retain.json'));
    expect(config.defaultMinStableRetain).toBe(2);
  });

  it('throws ConfigError when minStableRetain is negative or not an integer', () => {
    expect(() => loadConfig(fixture('invalid-min-stable-retain.json'))).toThrow(ConfigError);
  });
```

Update the existing `'parses a valid config file'` test's expectation (it currently asserts `config.plugins` without `minStableRetain`) to include the new field:

```ts
  it('parses a valid config file', () => {
    const config = loadConfig(fixture('valid.json'));
    expect(config.defaultRetain).toBe(5);
    expect(config.plugins).toEqual([
      { repo: 'acme/plugin-one', retain: undefined, minStableRetain: undefined },
      { repo: 'acme/plugin-two', retain: 10, minStableRetain: 3 },
      { repo: 'acme/plugin-three', retain: 'all', minStableRetain: undefined },
    ]);
  });
```

Update `mirror-builder/test/fixtures/config/valid.json` so `plugin-two` carries a `minStableRetain`:

```json
{
  "defaultRetain": 5,
  "plugins": [
    { "repo": "acme/plugin-one" },
    { "repo": "acme/plugin-two", "retain": 10, "minStableRetain": 3 },
    { "repo": "acme/plugin-three", "retain": "all" }
  ]
}
```

Create `mirror-builder/test/fixtures/config/valid-with-min-stable-retain.json`:

```json
{
  "defaultRetain": 5,
  "defaultMinStableRetain": 2,
  "plugins": [{ "repo": "acme/plugin-one" }]
}
```

Create `mirror-builder/test/fixtures/config/invalid-min-stable-retain.json`:

```json
{
  "defaultRetain": 5,
  "plugins": [{ "repo": "acme/plugin-one", "minStableRetain": -1 }]
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mirror-builder && npx vitest run test/config.test.ts`
Expected: FAIL — `defaultMinStableRetain` is `undefined` not `0`, and `minStableRetain` is missing from parsed plugin entries; the invalid-value test fails because nothing rejects it yet.

- [ ] **Step 3: Implement the minimal config changes**

In `mirror-builder/src/config.ts`, add a validator and wire it into both the top-level and per-plugin parsing:

```ts
export interface PluginConfigEntry {
  repo: string;
  retain?: number | 'all';
  minStableRetain?: number;
}

export interface TrackedPluginsConfig {
  defaultRetain: number | 'all';
  defaultMinStableRetain: number;
  plugins: PluginConfigEntry[];
}
```

Add alongside `isValidRetain`:

```ts
function isValidMinStableRetain(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
```

In `loadConfig`, after the existing `defaultRetain` validation block:

```ts
  if (obj.defaultMinStableRetain !== undefined && !isValidMinStableRetain(obj.defaultMinStableRetain)) {
    throw new ConfigError('"defaultMinStableRetain" must be a non-negative integer');
  }
  const defaultMinStableRetain = (obj.defaultMinStableRetain as number | undefined) ?? 0;
```

In the `plugins.map` callback, after the existing `e.retain` validation block:

```ts
    if (e.minStableRetain !== undefined && !isValidMinStableRetain(e.minStableRetain)) {
      throw new ConfigError(`plugins[${i}].minStableRetain must be a non-negative integer`);
    }
    return {
      repo: e.repo,
      retain: e.retain as number | 'all' | undefined,
      minStableRetain: e.minStableRetain as number | undefined,
    };
```

Update the final return statement:

```ts
  return { defaultRetain: obj.defaultRetain, defaultMinStableRetain, plugins };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mirror-builder && npx vitest run test/config.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
cd mirror-builder
git add src/config.ts test/config.test.ts test/fixtures/config/valid.json test/fixtures/config/valid-with-min-stable-retain.json test/fixtures/config/invalid-min-stable-retain.json
git commit -m "feat(mirror-builder): parse defaultMinStableRetain/minStableRetain config"
```

---

### Task 2: Stable-floor retention logic in `versionSort.ts`

**Files:**
- Modify: `mirror-builder/src/versionSort.ts`
- Test: `mirror-builder/test/versionSort.test.ts`

**Interfaces:**
- Consumes: `ReleaseCandidate { version: string; prerelease: boolean; publishedAt: string }`, `compareReleasesNewestFirst(a, b): number` (both already defined in this file).
- Produces: `applyRetention<T extends ReleaseCandidate>(sortedNewestFirst: T[], retain: number | 'all', minStableRetain?: number): T[]` — signature change from the current `applyRetention<T>(sortedNewestFirst: T[], retain: number | 'all'): T[]`. `minStableRetain` defaults to `0`, preserving current behavior when omitted.

- [ ] **Step 1: Write the failing tests**

Add to `mirror-builder/test/versionSort.test.ts`, inside `describe('applyRetention', ...)`, after the existing three tests:

```ts
  it('is unaffected by minStableRetain when the window already satisfies it', () => {
    const input = [
      candidate('2.0.0', '2026-03-01T00:00:00Z', false),
      candidate('1.9.0-beta.1', '2026-02-15T00:00:00Z', true),
      candidate('1.5.0', '2026-01-15T00:00:00Z', false),
    ];
    const result = applyRetention(input, 2, 1);
    expect(result.map((r) => r.version)).toEqual(['2.0.0', '1.9.0-beta.1']);
  });

  it('reaches back beyond retain to satisfy an unmet minStableRetain floor', () => {
    const input = [
      candidate('2.0.0-beta.3', '2026-05-01T00:00:00Z', true),
      candidate('2.0.0-beta.2', '2026-04-01T00:00:00Z', true),
      candidate('2.0.0-beta.1', '2026-03-01T00:00:00Z', true),
      candidate('1.5.0', '2026-02-01T00:00:00Z', false),
      candidate('1.0.0', '2026-01-01T00:00:00Z', false),
    ];
    const result = applyRetention(input, 2, 1);
    expect(result.map((r) => r.version)).toEqual([
      '2.0.0-beta.3',
      '2.0.0-beta.2',
      '1.5.0',
    ]);
  });

  it('stops once the floor is met and does not pull in more stable versions than requested', () => {
    const input = [
      candidate('3.0.0-beta.1', '2026-04-01T00:00:00Z', true),
      candidate('2.0.0', '2026-03-01T00:00:00Z', false),
      candidate('1.5.0', '2026-02-01T00:00:00Z', false),
      candidate('1.0.0', '2026-01-01T00:00:00Z', false),
    ];
    const result = applyRetention(input, 1, 2);
    expect(result.map((r) => r.version)).toEqual(['3.0.0-beta.1', '2.0.0', '1.5.0']);
  });

  it('ignores minStableRetain when retain is "all"', () => {
    const input = [
      candidate('2.0.0-beta.1', '2026-02-01T00:00:00Z', true),
      candidate('1.0.0', '2026-01-01T00:00:00Z', false),
    ];
    const result = applyRetention(input, 'all', 5);
    expect(result.map((r) => r.version)).toEqual(['2.0.0-beta.1', '1.0.0']);
  });

  it('leaves the retained set as-is when there are not enough stable versions to satisfy the floor', () => {
    const input = [
      candidate('2.0.0-beta.2', '2026-02-01T00:00:00Z', true),
      candidate('2.0.0-beta.1', '2026-01-01T00:00:00Z', true),
    ];
    const result = applyRetention(input, 2, 5);
    expect(result.map((r) => r.version)).toEqual(['2.0.0-beta.2', '2.0.0-beta.1']);
  });

  it('defaults minStableRetain to 0, matching prior behavior', () => {
    const input = [
      candidate('2.0.0-beta.1', '2026-02-01T00:00:00Z', true),
      candidate('1.0.0', '2026-01-01T00:00:00Z', false),
    ];
    expect(applyRetention(input, 1)).toEqual([input[0]]);
  });
```

Note: `candidate(version, publishedAt, prerelease)` is the existing test helper already defined at the top of this file — the new tests just pass `prerelease: true` explicitly where earlier tests relied on the default `false`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mirror-builder && npx vitest run test/versionSort.test.ts`
Expected: FAIL — `applyRetention` currently ignores the third argument entirely, so the "reaches back" and "stops once met" cases return only the naive top-N slice.

- [ ] **Step 3: Implement the minimal retention logic**

Replace `applyRetention` in `mirror-builder/src/versionSort.ts`:

```ts
export function applyRetention<T extends ReleaseCandidate>(
  sortedNewestFirst: T[],
  retain: number | 'all',
  minStableRetain = 0
): T[] {
  if (retain === 'all') return [...sortedNewestFirst];

  const window = sortedNewestFirst.slice(0, retain);
  const stableCount = window.filter((r) => !r.prerelease).length;
  const shortfall = minStableRetain - stableCount;
  if (shortfall <= 0) return window;

  const windowVersions = new Set(window.map((r) => r.version));
  const extra: T[] = [];
  for (const release of sortedNewestFirst.slice(retain)) {
    if (extra.length >= shortfall) break;
    if (!release.prerelease && !windowVersions.has(release.version)) {
      extra.push(release);
    }
  }

  return [...window, ...extra].sort(compareReleasesNewestFirst);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mirror-builder && npx vitest run test/versionSort.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
cd mirror-builder
git add src/versionSort.ts test/versionSort.test.ts
git commit -m "feat(mirror-builder): honor minStableRetain floor in applyRetention"
```

---

### Task 3: Wire `minStableRetain` through the CLI

**Files:**
- Modify: `mirror-builder/src/cli.ts`
- Test: `mirror-builder/test/cli.e2e.test.ts`

**Interfaces:**
- Consumes: `TrackedPluginsConfig.defaultMinStableRetain: number` and `PluginConfigEntry.minStableRetain?: number` (Task 1), `applyRetention<T extends ReleaseCandidate>(sorted, retain, minStableRetain?)` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `mirror-builder/test/cli.e2e.test.ts`, inside `describe('run', ...)`, after the last existing test:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mirror-builder && npx vitest run test/cli.e2e.test.ts`
Expected: FAIL — `defaultMinStableRetain` from the config is parsed (Task 1) but never reaches `applyRetention`, so only `2.0.0-beta.2` is retained and `versions.latest` is `null`.

- [ ] **Step 3: Implement the wiring**

In `mirror-builder/src/cli.ts`, update the `processPlugin` signature and body:

```ts
async function processPlugin(
  entry: PluginConfigEntry,
  defaultRetain: number | 'all',
  defaultMinStableRetain: number,
  releasesResult: RepoFetchResult,
  outDir: string,
  token?: string
): Promise<PluginResult> {
```

Change the retention lines:

```ts
  const sorted = sortReleasesNewestFirst(validated);
  const retain = entry.retain ?? defaultRetain;
  const minStableRetain = entry.minStableRetain ?? defaultMinStableRetain;
  const retained = applyRetention(sorted, retain, minStableRetain);
```

Update the call site inside `run`:

```ts
    const result = await processPlugin(
      plugin,
      config.defaultRetain,
      config.defaultMinStableRetain,
      releasesByRepo.get(plugin.repo)!,
      options.outDir,
      options.githubToken
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mirror-builder && npx vitest run test/cli.e2e.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
cd mirror-builder
git add src/cli.ts test/cli.e2e.test.ts
git commit -m "feat(mirror-builder): thread minStableRetain through the CLI pipeline"
```

---

### Task 4: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd mirror-builder && npx vitest run`
Expected: PASS — every test file (`versionSort`, `writer`, `cli.e2e`, `manifestReader`, `smoke`, `assets`, `github`, `config`) passes with no failures.

- [ ] **Step 2: Type-check**

Run: `cd mirror-builder && npx tsc --noEmit`
Expected: no errors (confirms `applyRetention`'s generic constraint change and the new `TrackedPluginsConfig`/`PluginConfigEntry` fields don't break any caller).

- [ ] **Step 3: Confirm no unintended diff to `tracked-plugins.json`**

Run: `cd mirror-builder && git diff --stat tracked-plugins.json`
Expected: no output — this task must not touch the existing repo's tracked-plugins.json (it has no `minStableRetain`/`defaultMinStableRetain` keys, and none are required since they default to `0`).
