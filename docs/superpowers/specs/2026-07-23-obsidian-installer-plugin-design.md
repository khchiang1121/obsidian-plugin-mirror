# Design: Obsidian Installer Plugin (Subsystem B)

Date: 2026-07-23
Status: Draft — pending final review

## Background

This is the second of two subsystem specs referenced by
`docs/superpowers/specs/2026-07-23-mirror-format-design.md` (the shared
static-file format both subsystems must produce/consume). The installer
plugin is the half that runs inside the restricted network, as an Obsidian
community plugin. It talks only to the internal nginx mirror server (never
GitHub) to let a vault owner browse which beta plugins are mirrored, install
one, and keep installed mirrored plugins up to date.

Unlike BRAT, which requires the user to type in an arbitrary `owner/repo` to
track, this plugin's mirror already publishes a curated `index.json`
registry of everything available (see the shared format spec). The primary
UX is therefore "browse and click Install," not "paste a repo path."

## Goals

- A settings tab lists every plugin published in the mirror's `index.json`
  (name, author, description, latest version) with an Install action.
- Installing a plugin downloads its files from the mirror and installs +
  enables it in the vault, without the user ever needing GitHub access.
- Already-installed mirrored plugins are tracked by this plugin (their
  `owner/repo` and installed version), independent of Obsidian's own
  `manifest.json`, which carries no such mapping.
- Update checking follows the shared format spec's candidate/compare rule
  exactly, respecting a **per-plugin** "allow prerelease" opt-in.
- Update checks run automatically once per Obsidian startup, and can also be
  triggered manually. Whether checks auto-run, and whether a found update is
  installed automatically or left for the user to approve, are each
  independently toggleable in settings.
- A mirrored plugin can be removed (disabled, files deleted, tracking
  entry dropped) from this plugin's own UI.
- One failing plugin (network error, 404, disk error) never prevents the
  rest of a browse list or update-check batch from completing.

## Non-goals

- Anything already decided by the shared format spec (directory layout,
  JSON schemas, sort/comparison rules) — this document only covers how the
  installer plugin consumes that format, not the format itself.
- Multiple simultaneous mirror servers — one `mirrorBaseUrl` per vault.
- Manual `owner/repo` entry outside the registry list — every installable
  plugin comes from the mirror's `index.json`.
- Access control / auth against the mirror server — the shared format spec
  treats the mirror as running on a trusted internal network with no auth,
  so the installer plugin makes plain unauthenticated requests.
- Distribution of this plugin itself — how a vault owner initially obtains
  and installs the installer plugin is outside this spec.

## Approach

Standard Obsidian community-plugin project: TypeScript, bundled with esbuild
to `main.js`, same toolchain as the official sample plugin and BRAT. Code is
split into small, independently testable modules rather than one monolithic
`main.ts`:

| Module | Responsibility |
|---|---|
| `main.ts` | Plugin entry point: lifecycle (`onload`/`onunload`), registers the settings tab + commands, wires the startup auto-check |
| `settings.ts` | Settings data shape, load/save via Obsidian's `loadData`/`saveData`, defaults |
| `registry.ts` | Fetch + parse `index.json` and `versions.json` from the configured mirror base URL |
| `versionCompare.ts` | Pure functions: semver-with-fallback compare/sort, candidate selection — same rule as the shared format spec / BRAT's `githubUtils.ts` |
| `installer.ts` | Download a version's files, write them into `.obsidian/plugins/<id>/`, enable the plugin via Obsidian's plugin API |
| `updater.ts` | For each tracked installed plugin: fetch `versions.json`, decide if a newer version exists (respecting per-plugin prerelease opt-in), trigger install |
| `settingsTab.ts` | Renders the registry browse list (Install buttons), the installed-plugins list (per-plugin prerelease toggle, Remove button, manual "Check for updates" action), and the mirror URL field |

`versionCompare.ts` and `registry.ts`'s parsing logic are pure/mockable and
unit-testable with no Obsidian API involved. `installer.ts`/`updater.ts`
depend on Obsidian's vault adapter and plugin-enable/disable API, so they're
tested with that surface mocked, kept isolated from the UI code in
`settingsTab.ts` (which is not unit tested — see Testing strategy).

## Data model (`data.json`, via Obsidian's `loadData`/`saveData`)

```ts
interface PluginSettings {
  mirrorBaseUrl: string;              // e.g. "https://plugins.internal.example.com/"
  autoCheckOnStartup: boolean;        // default true
  autoInstallUpdates: boolean;        // default true
  trackedPlugins: {
    [pluginId: string]: {
      repo: string;                  // "owner/repo", from index.json at install time
      installedVersion: string;
      allowPrerelease: boolean;      // default false — per-plugin opt-in
    };
  };
}
```

- `trackedPlugins` is this plugin's own bookkeeping. Obsidian's own
  `manifest.json` inside each installed plugin's folder carries no
  `repo` field, so this map is the only place that association lives —
  the same reason BRAT keeps its own equivalent list.
- `installedVersion` is updated on every successful install; it is the
  source of truth for "what version is installed," independent of whether
  that version's folder still exists on the mirror (the shared format
  spec's noted retention-pruning limitation affects display of this value,
  not the install/update mechanics).
- Removing a plugin deletes both its files and its `trackedPlugins` entry.

## Flows

### Browse & install (settings tab)

1. On settings-tab open, fetch `<mirrorBaseUrl>/index.json`. Render each
   entry (name, author, description, latest version). If a plugin's `id` is
   already a key in `trackedPlugins`, show "Installed vX.Y.Z" + a Remove
   action instead of Install.
2. On Install: fetch that plugin's `plugins/<owner>/<repo>/versions.json`,
   select a version using the shared format spec's candidate rule
   (`prerelease: false` only, since a plugin isn't in `trackedPlugins` yet
   and therefore has no `allowPrerelease` opt-in on first install), download
   its files from `plugins/<owner>/<repo>/<version>/` into
   `<vault>/.obsidian/plugins/<id>/`, then call Obsidian's
   `app.plugins.enablePlugin(id)`. Add a `trackedPlugins` entry. Show an
   Obsidian `Notice` on success or failure.

### Update check (manual command/button, and automatically once per Obsidian
startup if `autoCheckOnStartup` is enabled)

1. For each entry in `trackedPlugins`, fetch its `versions.json` and apply
   the shared format spec's candidate/compare rule using that plugin's own
   `allowPrerelease` value.
2. If the selected candidate is newer than `installedVersion`:
   - If `autoInstallUpdates` is enabled, install it silently (same
     download/write/enable steps as install) and record it; after the full
     batch finishes, show one summary `Notice` listing everything that was
     updated (not one `Notice` per plugin).
   - If disabled, surface it in the settings list as "update available"
     with a manual Install button instead of installing automatically.

### Remove

Call `app.plugins.disablePlugin(id)`, delete
`<vault>/.obsidian/plugins/<id>/` via the vault adapter, delete the
`trackedPlugins` entry.

## Error handling

Every network or file operation (mirror unreachable, 404 on a
retention-pruned version, disk write failure) is caught per-plugin: logged
to console and surfaced as a `Notice`, and never stops the rest of a browse
list render or update-check batch from completing. This mirrors subsystem
A's "one failure is never fatal to the whole run" behavior.

## Testing strategy

- `versionCompare.ts` — pure functions; unit test the same edge cases as
  subsystem A (all-semver, all-non-semver, mixed, prerelease filtering).
- `registry.ts` — parsing logic unit tested against fixture JSON matching
  the shared format spec; network calls mocked (e.g. `msw` or a stubbed
  `fetch`).
- `installer.ts` / `updater.ts` — Obsidian's vault adapter and
  `app.plugins` API are mocked with thin fakes covering only the surface
  used (`adapter.write`, `adapter.mkdir`, `adapter.remove`,
  `plugins.enablePlugin`, `plugins.disablePlugin`); tests assert correct
  file writes and correct enable/disable calls without a real Obsidian
  instance.
- `settingsTab.ts` — not unit tested; Obsidian's `Setting`/DOM APIs aren't
  meaningfully testable outside the app. Verified manually by loading the
  built plugin in a real vault before considering UI work complete.
- Test runner: **vitest** (fast, native TS/ESM support, minimal config).
