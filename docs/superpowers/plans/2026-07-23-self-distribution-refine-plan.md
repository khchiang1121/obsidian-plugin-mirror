# Self-Distribution Mechanism Refine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the registry-shaped self-distribution mechanism (`bundleLocalPlugin.ts` / `updateOne.ts` duality, 3-stage Dockerfile) with one fixed, version-less endpoint (`/self/manifest.json`, `/self/main.js`) and a simplified `selfUpdate.ts`.

**Architecture:** mirror-builder's Dockerfile drops to 2 stages (build the plugin from source, copy 2 files straight into the nginx image). `obsidian-installer-plugin`'s `selfUpdate.ts` becomes self-contained — fetch one manifest, compare semver, download 2 fixed files — with no registry types.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-self-distribution-refine-design.md` — read it before starting.
- Do NOT `git commit` or `git push` — this project's standing rule requires explicit user request before any commit.
- Preserve the 3 original self-update UX constraints (no new top-level settings block, self never listed as a regular tracked plugin, update always requires a manual Obsidian reload) — verify by inspection at the end, not by re-deriving them.

---

### Task 1: mirror-builder — delete the two overlapping build tools

**Files:**
- Delete: `mirror-builder/src/bundleLocalPlugin.ts`
- Delete: `mirror-builder/test/bundleLocalPlugin.test.ts`
- Delete: `mirror-builder/src/updateOne.ts`
- Delete: `mirror-builder/test/updateOne.test.ts`
- Modify: `mirror-builder/package.json`

- [ ] **Step 1: Delete the four files above**

```bash
cd mirror-builder
rm src/bundleLocalPlugin.ts test/bundleLocalPlugin.test.ts src/updateOne.ts test/updateOne.test.ts
```

- [ ] **Step 2: Remove their npm scripts from `package.json`**

Remove these two lines from `"scripts"`:
```json
    "update-one": "tsx src/updateOne.ts",
    "bundle-local-plugin": "tsx src/bundleLocalPlugin.ts",
```

- [ ] **Step 3: Run the test suite to confirm nothing else referenced them**

Run: `cd mirror-builder && npm test`
Expected: all remaining tests pass (no import errors from other files referencing the deleted modules — confirm via `grep -rn "bundleLocalPlugin\|updateOne" mirror-builder/src mirror-builder/test` returning nothing).

---

### Task 2: mirror-builder — simplify the Dockerfile to 2 stages

**Files:**
- Modify: `mirror-builder/Dockerfile`

- [ ] **Step 1: Replace the Dockerfile contents**

```dockerfile
# main.js is gitignored (a build artifact, not committed) and manifest.json's
# version can be bumped without anyone remembering to rebuild it — this stage
# always builds obsidian-installer-plugin from current source, so the image
# never bundles a stale or missing main.js.
FROM node:22-alpine AS plugin-build
WORKDIR /build
COPY obsidian-installer-plugin/package.json obsidian-installer-plugin/package-lock.json ./
RUN npm ci
COPY obsidian-installer-plugin/ ./
RUN npm run build

FROM nginx:alpine

RUN apk update && \
    apk add --no-cache --upgrade openssl libssl3 libcrypto3

COPY mirror-builder/nginx/default.conf /etc/nginx/conf.d/default.conf

# Base image ships its own /usr/share/nginx/html/index.html ("Welcome to
# nginx!"); COPY only adds/overwrites files, it never removes it, and it
# would otherwise win over index.json at the mirror root.
RUN rm -rf /usr/share/nginx/html/*

COPY mirror-builder/dist/ /usr/share/nginx/html/
COPY docs/ /usr/share/nginx/html/docs/

# The installer plugin's own build, always current — fixed, version-less
# path (no index.json entry, no version history: self-update only ever
# needs "the current build, right now").
COPY --from=plugin-build /build/manifest.json /build/main.js /usr/share/nginx/html/self/

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1
```

- [ ] **Step 2: Build and verify**

Run (from `mirror-builder/`):
```bash
docker build -t obsidian-plugin-mirror -f Dockerfile ..
docker run --rm -d --name self-refine-check -p 18096:80 obsidian-plugin-mirror
sleep 1
curl -s http://localhost:18096/self/manifest.json
curl -s http://localhost:18096/self/main.js | head -c 60
curl -s http://localhost:18096/index.json | python3 -c "import json,sys; d=json.load(sys.stdin); print([p['repo'] for p in d['plugins'] if 'obsidian-plugin-mirror' in p['repo']])"
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18096/
curl -s http://localhost:18096/health
docker stop self-refine-check
docker rmi obsidian-plugin-mirror
```
Expected: `/self/manifest.json` returns the current manifest (version matching `obsidian-installer-plugin/manifest.json`), `/self/main.js` starts with the esbuild banner, the `index.json` filter prints `[]` (no entry for this repo anymore), `/` returns `302`, `/health` returns `ok`.

---

### Task 3: mirror-builder — update README

**Files:**
- Modify: `README.md` (repo root)

- [ ] **Step 1: Replace the self-distribution bullet under "The same nginx container also serves:"**

Find:
```
Every `docker build` also builds `obsidian-installer-plugin` from current source and merges it into the registry as a normal entry (`index.json` + `plugins/khchiang1121/obsidian-plugin-mirror/…`), the same shape `update-one` produces — see below. This is what the plugin's own self-update check reads, so it's always current with the source, not whatever was last manually released.
```
Replace with:
```
Every `docker build` also builds `obsidian-installer-plugin` from current source and copies it to `/self/manifest.json` and `/self/main.js` — a fixed, version-less path (no `index.json` entry, no version history). This is what the plugin's own self-update check reads, so it's always current with source.
```

- [ ] **Step 2: Replace the "Keeping obsidian-installer-plugin's own registry entry current" section**

Find the whole section from `#### Keeping obsidian-installer-plugin's own registry entry current` through the paragraph ending `...not \`mirror-builder/\` itself.` (this spans the automatic-bundling bullet, the manual `update-one` bash block, and the build-context note).

Replace with:
```markdown
#### Why obsidian-installer-plugin isn't in tracked-plugins.json

`obsidian-installer-plugin/` is deliberately **not** listed in `tracked-plugins.json` and has no `index.json` entry — cutting a new build of it shouldn't require (or trigger) re-fetching all ~200 tracked open-source plugins, and self-update only ever needs "the current build, right now," not a version history. Every `docker build` compiles it from source and serves it at `/self/manifest.json` / `/self/main.js` (see above) — no separate release step.

The build context is the repo root (`..`, since `Dockerfile` lives in `mirror-builder/` but also bundles `docs/` — see below), not `mirror-builder/` itself.
```

- [ ] **Step 3: Confirm no remaining references**

Run: `grep -n "update-one\|bundle-local-plugin" README.md`
Expected: no matches.

---

### Task 4: obsidian-installer-plugin — export `cacheBust` from `registry.ts`

**Files:**
- Modify: `obsidian-installer-plugin/src/registry.ts`

**Interfaces:**
- Produces: `export function cacheBust(url: string): string` (was private).

- [ ] **Step 1: Make `cacheBust` exported**

Change:
```ts
function cacheBust(url: string): string {
```
to:
```ts
export function cacheBust(url: string): string {
```
(no other change to the file — its two call sites, `fetchIndex`/`fetchVersions`, are unaffected by widening the export.)

- [ ] **Step 2: Typecheck**

Run: `cd obsidian-installer-plugin && npm run typecheck`
Expected: no errors.

---

### Task 5: obsidian-installer-plugin — rewrite `selfUpdate.ts`

**Files:**
- Modify: `obsidian-installer-plugin/src/selfUpdate.ts`
- Test: `obsidian-installer-plugin/test/selfUpdate.test.ts`

**Interfaces:**
- Consumes: `cacheBust` from `./registry` (Task 4), `type FetchLike` from `./obsidianFetch`, `type VaultAdapterLike` from `./installer`.
- Produces: `type SelfUpdateStatus = { status: 'up-to-date' } | { status: 'update-available'; version: string } | { status: 'error'; error: string }`; `checkSelfUpdate(mirrorBaseUrl, installedVersion, fetchFn?)`; `downloadSelfUpdate(adapter, mirrorBaseUrl, pluginId, fetchFn?)`.

- [ ] **Step 1: Write the failing test — replace `test/selfUpdate.test.ts` entirely**

```ts
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
    server.use(
      http.get(`${MIRROR}/self/manifest.json`, () => HttpResponse.json({}, { status: 404 }))
    );
    const adapter: VaultAdapterLike = { mkdir: async () => {}, write: async () => {}, rmdir: async () => {}, read: async () => '' };
    await expect(downloadSelfUpdate(adapter, MIRROR, 'obsidian-mirror-installer')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd obsidian-installer-plugin && npx vitest run test/selfUpdate.test.ts`
Expected: FAIL — old `selfUpdate.ts` doesn't export `downloadSelfUpdate`, and `checkSelfUpdate`'s signature doesn't match.

- [ ] **Step 3: Replace `src/selfUpdate.ts` entirely**

```ts
import semver from 'semver';
import { cacheBust } from './registry';
import type { FetchLike } from './obsidianFetch';
import type { VaultAdapterLike } from './installer';

export interface SelfManifest {
  id: string;
  version: string;
}

export type SelfUpdateStatus =
  | { status: 'up-to-date' }
  | { status: 'update-available'; version: string }
  | { status: 'error'; error: string };

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Self-update is deliberately not routed through the registry format used
 * for the ~200 GitHub-mirrored plugins (index.json + versions.json) — it
 * only ever needs "is there something newer than what I have right now,"
 * not version history or a picker. The mirror always serves the current
 * build at this fixed, version-less path; see mirror-builder's Dockerfile.
 */
export async function checkSelfUpdate(
  mirrorBaseUrl: string,
  installedVersion: string,
  fetchFn: FetchLike = fetch
): Promise<SelfUpdateStatus> {
  const url = `${trimTrailingSlash(mirrorBaseUrl)}/self/manifest.json`;
  try {
    const response = await fetchFn(cacheBust(url));
    if (!response.ok) {
      return { status: 'error', error: `HTTP ${response.status}` };
    }
    const manifest = (await response.json()) as Partial<SelfManifest>;
    const remote = typeof manifest.version === 'string' ? semver.coerce(manifest.version) : null;
    if (!remote) {
      return { status: 'error', error: 'Mirror returned an invalid manifest.json' };
    }
    const installed = semver.coerce(installedVersion);
    if (installed && semver.gt(remote, installed)) {
      return { status: 'update-available', version: manifest.version! };
    }
    return { status: 'up-to-date' };
  } catch (error) {
    return { status: 'error', error: (error as Error).message };
  }
}

/**
 * Downloads the current build's two files into the running plugin's own
 * folder without touching the plugin manager — applying an update to a
 * plugin's own running code isn't safe to do in place, so this always
 * requires a manual Obsidian reload afterwards (see settingsTab.ts).
 */
export async function downloadSelfUpdate(
  adapter: VaultAdapterLike,
  mirrorBaseUrl: string,
  pluginId: string,
  fetchFn: FetchLike = fetch
): Promise<void> {
  const base = trimTrailingSlash(mirrorBaseUrl);
  const pluginDir = `.obsidian/plugins/${pluginId}`;
  for (const file of ['manifest.json', 'main.js']) {
    const url = `${base}/self/${file}`;
    const response = await fetchFn(cacheBust(url));
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status}`);
    }
    const content = await response.text();
    await adapter.write(`${pluginDir}/${file}`, content);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd obsidian-installer-plugin && npx vitest run test/selfUpdate.test.ts`
Expected: PASS (9 tests).

---

### Task 6: obsidian-installer-plugin — wire `settingsTab.ts` to the new `selfUpdate.ts`

**Files:**
- Modify: `obsidian-installer-plugin/src/settingsTab.ts`

- [ ] **Step 1: Update the import**

Change:
```ts
import { checkSelfUpdate } from './selfUpdate';
```
to:
```ts
import { checkSelfUpdate, downloadSelfUpdate } from './selfUpdate';
```
Remove the now-unused `downloadPluginFiles` import from `./installer` (keep `installPluginVersion`, `removePlugin`, `type VaultAdapterLike`, `type PluginManagerLike` — still used elsewhere in this file).

- [ ] **Step 2: Update the comment above `selfVersionSetting` in `display()`**

Change:
```ts
    // This plugin's own version lives here, among the other global settings
    // — not as a separate section, and not inside "Installed mirrored
    // plugins" (which only ever lists *other* plugins; see checkForUpdates'
    // excludeIds in main.ts). Filled in once loadPluginLists has the
    // registry — see renderSelfVersionRow.
```
to:
```ts
    // This plugin's own version lives here, among the other global settings
    // — not as a separate section, and not inside "Installed mirrored
    // plugins" (which only ever lists *other* plugins; see checkForUpdates'
    // excludeIds in main.ts). Checked independently of the registry fetch
    // below — see renderSelfVersionRow.
```

- [ ] **Step 3: Rewrite `loadPluginLists` to run the self-check independently**

Replace:
```ts
  private async loadPluginLists(
    selfVersionSetting: Setting,
    installedGroup: HTMLElement,
    installedHeadingEl: HTMLElement,
    registryGroup: HTMLElement,
    registryHeadingEl: HTMLElement
  ): Promise<void> {
    await this.plugin.runUpdateCheck();

    let entries: RegistryEntry[];
    try {
      const index = await fetchIndex(this.plugin.settings.mirrorBaseUrl, this.plugin.fetchFn);
      entries = index.plugins;
    } catch (error) {
      selfVersionSetting.setDesc(
        t('self.status.error', { version: this.plugin.manifest.version, message: (error as Error).message })
      );
      this.clearGroupBody(registryGroup, registryHeadingEl);
      registryGroup.createEl('p', { text: t('registry.loadError', { message: (error as Error).message }) });
      this.renderInstalledPlugins(installedGroup, installedHeadingEl);
      return;
    }

    const selfId = this.plugin.manifest.id;
    const otherEntries = entries.filter((e) => e.id !== selfId);

    await this.renderSelfVersionRow(selfVersionSetting, entries);
    this.renderInstalledPlugins(installedGroup, installedHeadingEl);
    this.renderRegistry(registryGroup, registryHeadingEl, otherEntries);
  }
```
with:
```ts
  private async loadPluginLists(
    selfVersionSetting: Setting,
    installedGroup: HTMLElement,
    installedHeadingEl: HTMLElement,
    registryGroup: HTMLElement,
    registryHeadingEl: HTMLElement
  ): Promise<void> {
    // Independent of the registry fetch below — it hits its own fixed
    // endpoint, so a slow or failing 200-plugin registry never blocks or
    // delays this plugin's own version check.
    void this.renderSelfVersionRow(selfVersionSetting);

    await this.plugin.runUpdateCheck();

    let entries: RegistryEntry[];
    try {
      const index = await fetchIndex(this.plugin.settings.mirrorBaseUrl, this.plugin.fetchFn);
      entries = index.plugins;
    } catch (error) {
      this.clearGroupBody(registryGroup, registryHeadingEl);
      registryGroup.createEl('p', { text: t('registry.loadError', { message: (error as Error).message }) });
      this.renderInstalledPlugins(installedGroup, installedHeadingEl);
      return;
    }

    const selfId = this.plugin.manifest.id;
    const otherEntries = entries.filter((e) => e.id !== selfId);

    this.renderInstalledPlugins(installedGroup, installedHeadingEl);
    this.renderRegistry(registryGroup, registryHeadingEl, otherEntries);
  }
```

- [ ] **Step 4: Rewrite `renderSelfVersionRow`**

Replace:
```ts
  private async renderSelfVersionRow(setting: Setting, entries: RegistryEntry[]): Promise<void> {
    const selfId = this.plugin.manifest.id;
    const currentVersion = this.plugin.manifest.version;

    const result = await checkSelfUpdate(this.plugin.settings.mirrorBaseUrl, entries, selfId, currentVersion, this.plugin.fetchFn);

    if (result.status === 'not-in-registry') {
      setting.setDesc(t('self.status.notInRegistry', { version: currentVersion }));
      return;
    }
    if (result.status === 'error') {
      setting.setDesc(t('self.status.error', { version: currentVersion, message: result.error ?? '' }));
      return;
    }
    if (result.status === 'up-to-date') {
      setting.setDesc(t('self.status.upToDate', { version: currentVersion }));
      return;
    }

    const candidate = result.candidate!;
    const repo = result.repo!;
    setting.setDesc(t('self.status.updateAvailable', { version: currentVersion, newVersion: candidate.version }));
    setting.addButton((button) =>
      button
        .setButtonText(t('self.button.update'))
        .setCta()
        .onClick(async () => {
          try {
            await downloadPluginFiles(
              this.getAdapter(),
              this.plugin.settings.mirrorBaseUrl,
              selfId,
              { repo, version: candidate.version, files: candidate.files },
              this.plugin.fetchFn
            );
            new Notice(t('notice.selfUpdated', { version: candidate.version }), 10000);
          } catch (error) {
            new Notice(t('notice.selfUpdateFailed', { message: (error as Error).message }));
          }
        })
    );
  }
```
with:
```ts
  private async renderSelfVersionRow(setting: Setting): Promise<void> {
    const selfId = this.plugin.manifest.id;
    const currentVersion = this.plugin.manifest.version;

    const result = await checkSelfUpdate(this.plugin.settings.mirrorBaseUrl, currentVersion, this.plugin.fetchFn);

    if (result.status === 'error') {
      setting.setDesc(t('self.status.error', { version: currentVersion, message: result.error }));
      return;
    }
    if (result.status === 'up-to-date') {
      setting.setDesc(t('self.status.upToDate', { version: currentVersion }));
      return;
    }

    setting.setDesc(t('self.status.updateAvailable', { version: currentVersion, newVersion: result.version }));
    setting.addButton((button) =>
      button
        .setButtonText(t('self.button.update'))
        .setCta()
        .onClick(async () => {
          try {
            await downloadSelfUpdate(this.getAdapter(), this.plugin.settings.mirrorBaseUrl, selfId, this.plugin.fetchFn);
            new Notice(t('notice.selfUpdated', { version: result.version }), 10000);
          } catch (error) {
            new Notice(t('notice.selfUpdateFailed', { message: (error as Error).message }));
          }
        })
    );
  }
```

- [ ] **Step 5: Typecheck**

Run: `cd obsidian-installer-plugin && npm run typecheck`
Expected: no errors.

---

### Task 7: obsidian-installer-plugin — drop the dead `self.status.notInRegistry` i18n key

**Files:**
- Modify: `obsidian-installer-plugin/src/i18n/locales/en.ts`
- Modify: `obsidian-installer-plugin/src/i18n/locales/zh-TW.ts`

- [ ] **Step 1: Remove the key from both files**

`en.ts` — remove:
```ts
  'self.status.notInRegistry': "Installed v{version} — not found in the mirror's registry.",
```

`zh-TW.ts` — remove:
```ts
  'self.status.notInRegistry': '已安裝 v{version} — 在鏡像清單中找不到此外掛。',
```

- [ ] **Step 2: Run the i18n parity test**

Run: `cd obsidian-installer-plugin && npx vitest run test/i18n.test.ts`
Expected: PASS — `en`/`zh-TW` key sets still match (both dropped the same key).

---

### Task 8: Full verification

- [ ] **Step 1: mirror-builder**

Run: `cd mirror-builder && npm test`
Expected: all tests pass (no reference to deleted `bundleLocalPlugin`/`updateOne`).

- [ ] **Step 2: obsidian-installer-plugin**

Run: `cd obsidian-installer-plugin && npm test && npm run typecheck && npm run build`
Expected: all pass, build succeeds.

- [ ] **Step 3: grep for stray references**

Run: `grep -rn "RegistryEntry\|VersionEntry\|findSelfRegistryEntry\|not-in-registry" obsidian-installer-plugin/src/selfUpdate.ts obsidian-installer-plugin/src/settingsTab.ts`
Expected: no matches (all registry-format coupling removed from the self-update path; `settingsTab.ts` may still reference `RegistryEntry`/`VersionEntry` for the *generic* registry rendering — that's fine and expected, just confirm none of it is in the self-update code paths specifically by reading the surrounding context).

- [ ] **Step 4: Docker end-to-end** (same as Task 2 Step 2, re-run after all code changes)

Run the same build+curl sequence as Task 2 Step 2. Expected: identical results.

- [ ] **Step 5: Report and stop — do not commit**

Summarize what changed, confirm all verification steps passed, and wait for the user to explicitly request a commit.
