# Minimum Stable Retention Design

## Problem

`mirror-builder` retains the newest `retain` (or `defaultRetain`) releases for each
tracked plugin, sorted newest-first without regard to prerelease status. If a plugin
publishes a run of prereleases, they can fill the entire retention window and push
every stable (non-prerelease) version out, leaving `latestVersion` in `versions.json`
`null` and no installable stable build mirrored at all.

## Goal

Let users configure a minimum number of non-prerelease versions that must always be
retained, on top of the existing newest-first retention window.

## Config Changes (`src/config.ts`)

Add a new optional setting, mirroring how `retain`/`defaultRetain` already work:

- `defaultMinStableRetain?: number` — top-level default. Optional; defaults to `0`
  (no floor) when absent, so existing `tracked-plugins.json` files keep working
  unchanged.
- `PluginConfigEntry.minStableRetain?: number` — per-plugin override, same
  optional/default-to-parent pattern as `retain`.

Validation: must be a non-negative integer (`0` is valid and means "no floor",
unlike `retain`/`defaultRetain` which must be a positive integer or `"all"`).

Example:

```json
{
  "defaultRetain": 10,
  "defaultMinStableRetain": 3,
  "plugins": [
    { "repo": "owner/repo" },
    { "repo": "owner/repo2", "minStableRetain": 5 }
  ]
}
```

## Retention Logic (`src/versionSort.ts`)

Extend `applyRetention`:

```ts
export function applyRetention<T extends ReleaseCandidate>(
  sortedNewestFirst: T[],
  retain: number | 'all',
  minStableRetain = 0
): T[]
```

Behavior:

1. If `retain === 'all'`, return everything (unchanged) — the floor is moot since
   every stable version is already retained.
2. Otherwise take the top `retain` newest entries, as today.
3. Count non-prerelease (`prerelease === false`) entries in that window.
4. If the count is below `minStableRetain`, walk further back through the
   remaining (older) entries of `sortedNewestFirst`, in newest-first order,
   collecting additional non-prerelease entries until the floor is met or the
   source list is exhausted.
5. Merge the retain-window entries with any additional stable entries pulled in
   by step 4, and re-sort the combined set newest-first (reusing
   `compareReleasesNewestFirst`) so the result is a single clean chronological
   list. Total size may exceed `retain` when the floor requires reaching back
   further than the window.

The generic constraint changes from `<T>` to `<T extends ReleaseCandidate>` since
the function now needs to read `.prerelease`. `ValidatedVersion` (used at the
current call site) already satisfies `ReleaseCandidate`'s shape, so no caller-side
type changes are needed beyond passing the new argument.

## Call Site (`src/cli.ts`)

In `processPlugin`, resolve the effective floor the same way `retain` is resolved:

```ts
const retain = entry.retain ?? defaultRetain;
const minStableRetain = entry.minStableRetain ?? defaultMinStableRetain ?? 0;
const retained = applyRetention(sorted, retain, minStableRetain);
```

`defaultMinStableRetain` is threaded through from `config` the same way
`defaultRetain` already is (passed into `processPlugin` as a parameter).

## Testing

`test/config.test.ts`:
- Parses `defaultMinStableRetain` and per-plugin `minStableRetain` when present.
- Defaults `defaultMinStableRetain` to `0` when absent from the config file.
- Throws `ConfigError` when `defaultMinStableRetain`/`minStableRetain` is negative
  or not an integer.

`test/versionSort.test.ts`:
- Floor pulls in older stable versions beyond the `retain` window when the window
  alone doesn't contain enough stable versions.
- Floor is a no-op (no extra versions added) when the `retain` window already
  satisfies it.
- `retain: 'all'` ignores the floor (nothing to add, everything is already kept).
- Merged result stays sorted newest-first, including when extra stable versions
  were pulled in from further back.
- Existing behavior (no floor / `minStableRetain` omitted or `0`) is unchanged.

## Out of Scope

- No change to prerelease handling beyond ensuring they don't crowd out the
  stable floor — prereleases inside the normal `retain` window are still kept as
  before.
- No UI/README changes beyond documenting the new config keys where `retain` is
  already documented (if such docs exist).
