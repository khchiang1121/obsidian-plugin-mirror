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
- Re-running against an existing output directory only downloads what's
  new — it doesn't re-fetch every asset from scratch every time.

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

### Incremental runs

The release list always comes from a fresh GitHub API call — that's the
only way to learn about new releases, so this happens on every run
regardless of whether it's the first or the hundredth. What's skipped on
repeat runs is the expensive part: re-downloading asset files that are
already sitting in the output directory from a previous run.

The output directory itself is the only state carried between runs — there
is no separate cache file or database. This keeps the tool one-shot and
daemon-free: state is just whatever's on disk from last time, and a missing
output directory (first run, or a fresh checkout) is indistinguishable from
"nothing cached yet."

For each retained version (after sorting + retention are computed from the
freshly-fetched release list): if
`dist/plugins/<owner>/<repo>/<version>/` already exists and already
contains every file the release is expected to have, downloading is skipped
entirely and the existing files are reused as-is. Otherwise (new version,
or a directory that's missing/incomplete) the assets are downloaded fresh.

After the retained set for a plugin is finalized, any version directories
already on disk under `dist/plugins/<owner>/<repo>/` that are *not* in that
set are deleted. This is what keeps a shrinking `retain` count, or a
release being deleted/unpublished upstream, correctly reflected in the
output instead of leaving stale, no-longer-listed version directories
behind — the output tree always matches what the current run's `versions.json`
says exists, never a superset of it.

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
   - For each retained version: if its output directory already exists
     with all expected files, skip downloading (reuse it as-is); otherwise
     download its assets (`manifest.json`, `main.js`, and
     `styles.css`/`manifest-beta.json` if present) into
     `dist/plugins/<owner>/<repo>/<version>/` (see "Incremental runs"
     above).
   - Delete any pre-existing version directories under
     `dist/plugins/<owner>/<repo>/` that fall outside the retained set
     (handles retention shrinking and upstream-deleted releases).
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
| `assets.ts` | Determine which required/optional assets exist on a release; check whether a version's output directory is already complete; download when it isn't; prune retained-out version directories |
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
- Incremental-run scenarios — seed a `dist/` directory as if from a prior
  run, then run the CLI again against updated mock release data, and
  assert: (a) already-complete version directories are not re-downloaded
  (no download calls made for them), (b) a newly-published release is
  downloaded, (c) a version pushed outside the retention window by the new
  run is deleted from disk, and (d) a release removed/unpublished upstream
  is likewise deleted.
