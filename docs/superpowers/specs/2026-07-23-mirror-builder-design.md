# Design: mirror-builder (Subsystem A)

Date: 2026-07-23
Status: Draft — pending final review

## Background

This is the first of two subsystem specs referenced by
`docs/superpowers/specs/2026-07-23-mirror-format-design.md` (the shared
static-file format both subsystems must produce/consume). mirror-builder is
the half that runs outside the restricted network: it reads a list of
tracked GitHub repos (beta Obsidian plugins), fetches their releases, and
lays the result out on disk exactly as the shared format spec requires, so
it can be served by a plain nginx static file server.

## Goals

- A single CLI command produces a complete, spec-compliant static file tree
  from a tracked-plugin config file.
- No persistent/daemon process, no external scheduler dependency baked into
  the tool itself. Re-running the build periodically is left entirely to
  whatever invokes the CLI (manual, cron, CI) — out of scope here.
- No implicit dependency on Docker inside the core CLI. Turning the output
  into an nginx image is a separate, explicit step.
- One failing plugin (bad repo, missing release assets, network error)
  never prevents the rest of the tracked plugins from being mirrored
  successfully.
- Per-plugin metadata for the registry (`index.json`) is derived
  automatically from each plugin's own `manifest.json`, so the tracked-list
  config only needs to name the repo.

## Non-goals

- Scheduling/automating repeat runs — left to the operator.
- Building or pushing the Docker image — the CLI only produces the static
  file tree and reads a checked-in Dockerfile; invoking `docker build` is a
  separate, explicit step (see "Docker packaging" below).
- Any UI/UX — this is a CLI/library only.
- Anything already decided by the shared format spec (directory layout,
  JSON schemas, sort/comparison rules) — this document only covers how
  mirror-builder produces that output, not the output format itself.

## Approach

Node.js/TypeScript CLI. GitHub API access via `@octokit/rest` (handles auth,
pagination, and rate-limit headers) rather than hand-rolled `fetch` calls,
since the tool must already support an optional `GITHUB_TOKEN` and
hand-rolling pagination/rate-limit retry logic would duplicate what octokit
already does reliably. Repos are processed with bounded concurrency (a
fixed constant, e.g. 5 at a time) rather than fully serial, so a tracked
list of dozens of plugins doesn't take proportionally longer to build.

### Docker packaging

The "one command produces an image" goal is met at the npm-script layer, not
inside the CLI: `npm run build:image` chains the static-file-generating CLI
with a plain `docker build` invocation against a fixed, checked-in
Dockerfile (`FROM nginx:alpine` + `COPY dist/ /usr/share/nginx/html/`). The
CLI itself has zero Docker dependency and can run (and be tested) with only
Node installed.

## Config file (`tracked-plugins.json`)

```json
{
  "defaultRetain": 5,
  "plugins": [
    { "repo": "owner/repo" },
    { "repo": "owner/other-repo", "retain": 10 },
    { "repo": "owner/keep-all-repo", "retain": "all" }
  ]
}
```

- `repo` (required): `owner/repo`, matching the GitHub repository path.
- `retain` (optional): how many versions to keep for this plugin, newest
  first, after sorting. Omitted → falls back to `defaultRetain`. May be the
  string `"all"` to keep every version found.
- `defaultRetain` (required at top level): fallback retention count for any
  plugin entry that omits `retain`.
- No `name`/`author`/`description` fields — those come from each plugin's
  own `manifest.json` (see "Metadata extraction" below), keeping the config
  file minimal.

## Pipeline

1. **Load & validate config.** Missing file, invalid JSON, or an empty
   `plugins` array is fatal: print an error, exit non-zero, write nothing.
   This is the only fatal-error path in the pipeline.
2. **Fetch releases per repo**, bounded concurrency via octokit. If
   `GITHUB_TOKEN` is set, requests are authenticated (5000 req/hr); if not,
   requests are anonymous (60 req/hr) and the CLI prints a one-time notice
   that this is happening.
3. **Per-repo processing** (failures here are isolated to that repo, never
   fatal to the run):
   - Repo fetch fails (404, network error, etc.) → log a warning, skip the
     entire plugin, produce no output for it.
   - For each release returned: it's only a valid mirrorable version if
     both `manifest.json` and `main.js` assets are present. A release
     missing either is logged as a warning and excluded from that plugin's
     version list (other releases of the same plugin are unaffected).
   - Sort remaining releases using the same rule as the shared format spec
     (and BRAT's `githubUtils.ts`): compare coerced semver when both tags
     parse; fall back to comparing `publishedAt` when a tag isn't valid
     semver. Newest first.
   - Apply retention: keep the first `retain` (or `defaultRetain`) entries
     after sorting; drop the rest. `"all"` means no truncation.
   - Download the retained versions' assets (`manifest.json`, `main.js`,
     and `styles.css`/`manifest-beta.json` if present) into
     `dist/plugins/<owner>/<repo>/<version>/`.
   - Write that plugin's `versions.json`. `latest` points at the newest
     retained non-prerelease version; if none of the retained versions are
     non-prerelease, `latest` is `null`.
   - **Metadata extraction**: read the `manifest.json` of the version
     pointed to by `latest` (or, if `latest` is `null`, the single newest
     retained version regardless of prerelease status) and pull
     `id`/`name`/`author`/`description` from it for this plugin's
     `index.json` entry.
   - If every release for this repo was excluded in the step above (no
     valid versions at all), the plugin is dropped entirely — no entry in
     `index.json`, no `plugins/<owner>/<repo>/` directory — and a warning
     is logged.
4. **Write `index.json`** covering every plugin that produced at least one
   valid version.
5. **Print a summary** (plugins succeeded, plugins/versions skipped and
   why) and exit 0 — a partial run (some plugins skipped) is still a
   successful run. Only the config-validation failure in step 1 exits
   non-zero.

## Components

| Module | Responsibility |
|---|---|
| `config.ts` | Load and validate `tracked-plugins.json` |
| `github.ts` | octokit client setup, release fetching, bounded-concurrency scheduling |
| `versionSort.ts` | Pure functions: semver-with-fallback sort, retention truncation |
| `assets.ts` | Determine which required/optional assets exist on a release; download them |
| `manifestReader.ts` | Extract `index.json` fields from a downloaded `manifest.json` |
| `writer.ts` | Write `index.json` / `versions.json` / version directories per the shared format spec |
| `cli.ts` | Orchestrates the pipeline, collects warnings, prints the summary, sets exit code |

## Error handling summary

| Situation | Behavior |
|---|---|
| Config file missing / invalid JSON / empty `plugins` | Fatal — exit ≠ 0, no output written |
| Single repo fetch fails | Skip that plugin, log warning, exit 0 |
| Single release missing required assets | Skip that version, log warning, other versions unaffected |
| All of a plugin's releases excluded | Drop the plugin entirely from output, log warning |

## Testing strategy

- `versionSort.ts` and `manifestReader.ts` are pure functions — unit test
  sort/retention edge cases directly (all-semver, all-non-semver, mixed,
  `retain: "all"`).
- `github.ts` / `assets.ts` — mock the GitHub API and asset downloads (e.g.
  `nock` or `msw`) to test the per-repo-fetch-failure and
  missing-required-asset skip paths in isolation.
- End-to-end — mock a handful of fake repos' full release data, run the CLI
  against them, and diff the resulting output tree against what the shared
  format spec requires.
