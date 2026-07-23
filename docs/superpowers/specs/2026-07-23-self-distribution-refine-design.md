# Self-Distribution Mechanism Refine — Design

**Goal:** Simplify how `obsidian-installer-plugin` gets its own build into the mirror and checks/applies its own updates, by dropping the shared 200-plugin registry format for this one special case and replacing two overlapping build mechanisms with exactly one.

**Scope:** Self-distribution/self-update only. The 200-plugin GitHub-mirroring pipeline, `docs/` serving, and `/health` stay untouched.

## Why

Self-update never needed what the registry format (`index.json` + `plugins/<repo>/versions.json` with version history, prerelease flags, per-version directories) provides — it only ever asks "is there something newer than what I have, right now." Forcing it into that shape produced:
- Two mechanisms writing the same registry entry (`update-one`, fetching from GitHub Releases; `bundleLocalPlugin`, packaging a local build) with no clear rule for which one is authoritative.
- A 3-stage Dockerfile (`plugin-build` → `mirror-assemble` → nginx) just to run that merge on every image build.
- `selfUpdate.ts` carrying `RegistryEntry`/`VersionEntry` types and a `not-in-registry` status that only exists because of the format mismatch.
- Self-version-row rendering artificially blocked on the full `fetchIndex()` (200-plugin) call succeeding, even though it doesn't use that data.

## New design

The mirror serves exactly two fixed, version-less files, always the current build:
- `GET /self/manifest.json`
- `GET /self/main.js`

No `index.json` entry, no `plugins/khchiang1121/obsidian-plugin-mirror/` directory, no version history. A rebuild simply overwrites these two files.

### mirror-builder

- **Dockerfile drops to 2 stages.** `plugin-build` (unchanged: builds `obsidian-installer-plugin` from source) → nginx stage now copies `manifest.json`/`main.js` straight from that stage to `/usr/share/nginx/html/self/`. The `mirror-assemble` stage is deleted entirely — no JSON merge, no copy of `mirror-builder/dist/` into an intermediate stage.
- **Delete `src/bundleLocalPlugin.ts` and `test/bundleLocalPlugin.test.ts`.** Nothing produces a registry-shaped entry for this plugin anymore, so there's nothing for it to do.
- **Delete `src/updateOne.ts` and `test/updateOne.test.ts`.** Its only real caller was releasing this plugin without touching the other ~200; that need no longer exists. `npm run generate` (the full pipeline) remains the only way to update the 200 GitHub-mirrored plugins.
- **`nginx/default.conf`**: no changes — `/self/manifest.json`/`/self/main.js` are just static files under the existing `location /`.
- **README**: replace the "Keeping obsidian-installer-plugin's own registry entry current" section with a short note that the plugin's build is always freshly compiled into the image at `/self/manifest.json`/`/self/main.js`, and remove `update-one`/`bundle-local-plugin` from the documented workflow entirely.

### obsidian-installer-plugin

- **`src/selfUpdate.ts` rewritten**, now self-contained (check + download, no registry types):
  ```ts
  export interface SelfManifest { id: string; version: string; }
  export type SelfUpdateStatus =
    | { status: 'up-to-date' }
    | { status: 'update-available'; version: string }
    | { status: 'error'; error: string };

  export async function checkSelfUpdate(
    mirrorBaseUrl: string,
    installedVersion: string,
    fetchFn: FetchLike = fetch
  ): Promise<SelfUpdateStatus>;

  export async function downloadSelfUpdate(
    adapter: VaultAdapterLike,
    mirrorBaseUrl: string,
    pluginId: string,
    fetchFn: FetchLike = fetch
  ): Promise<void>;
  ```
  `checkSelfUpdate` fetches `/self/manifest.json` (cache-busted the same way `registry.ts` already does, reusing its exported `cacheBust` helper — the same Electron `requestUrl` stale-cache bug applies to any repeatedly-fetched URL, not just `index.json`), compares versions via `semver.coerce`/`semver.gt`. `downloadSelfUpdate` fetches `/self/manifest.json` and `/self/main.js` and writes them into the running plugin's own folder — replacing the old call through `installer.ts`'s generic `downloadPluginFiles`, which assumed the `/plugins/<repo>/<version>/<file>` URL shape.
  - `registry.ts`'s private `cacheBust` becomes exported (no other change to that file).
  - `findSelfRegistryEntry` and the `not-in-registry` status are deleted — impossible now; the fetch either succeeds or errors.

- **`settingsTab.ts`**:
  - `renderSelfVersionRow` no longer takes `entries: RegistryEntry[]` and no longer blocks on `fetchIndex()`. `loadPluginLists` kicks it off as an independent, un-awaited call at the top (`void this.renderSelfVersionRow(selfVersionSetting)`), so a slow or failing 200-plugin registry fetch no longer delays or blocks the self-version check.
  - Its status branches drop from 4 to 3 (`error` / `up-to-date` / `update-available`), matching the new `SelfUpdateStatus`.
  - The button's `onClick` calls `downloadSelfUpdate` instead of `downloadPluginFiles`.
  - `self.status.notInRegistry` is removed from both `en.ts` and `zh-TW.ts` (dead key — the key-parity test still enforces they drop it together).

- **Tests**: `test/selfUpdate.test.ts` rewritten for the new shape (mock `GET /self/manifest.json` and `/self/main.js` via msw instead of `/plugins/<repo>/versions.json`). `test/installer.test.ts` unaffected (its `downloadPluginFiles`/`installPluginVersion` are unchanged — self no longer calls through them).

## What stays the same

- The three UX constraints from the original self-update design: no new top-level settings block, self never appears in "Installed mirrored plugins" / "Available in mirror", update downloads files only and always requires an Obsidian reload to apply.
- `main.ts`'s `excludeIds: [this.manifest.id]` passed into `checkForUpdates` (unrelated to this refactor — it's about generic-plugin adoption, not self-update).
- The defensive `id === selfId` filters already in `settingsTab.ts` (`renderInstalledList`, `otherEntries` filter) — cheap insurance against a self-entry ever leaking into `trackedPlugins` or the registry, left as-is.

## Verification

- `cd mirror-builder && npm test` — full suite minus the two deleted test files.
- `cd obsidian-installer-plugin && npm test`, `npm run typecheck`, `npm run build`.
- `docker build -f Dockerfile ..` from `mirror-builder/`, then verify: `/self/manifest.json` and `/self/main.js` serve the current build; `/index.json` no longer contains an entry for `khchiang1121/obsidian-plugin-mirror`; `/`, `/health`, `/docs/` unaffected.
