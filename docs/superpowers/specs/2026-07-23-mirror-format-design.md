# Design: Obsidian Plugin Mirror — Shared Static Format

Date: 2026-07-23
Status: Draft — pending final review

## Background

Obsidian users inside a restricted/offline corporate network cannot reach
GitHub, so tools like BRAT (which install beta plugins directly from GitHub
releases) don't work there. This project replaces the GitHub dependency with
an internally-hosted mirror.

The overall system has two independent subsystems, connected by the shared
static-file format defined in this document:

- **Subsystem A — mirror-builder**: run outside the restricted network. Reads
  a config listing which GitHub repos (beta plugins) to track, fetches their
  releases, lays the files out according to this spec, and packages the
  result into an nginx Docker image.
- **Subsystem B — Obsidian installer plugin**: runs inside the restricted
  network. Talks only to the internal nginx server (never GitHub) to browse
  available plugins, install them, and check for updates.

`nginx` itself needs no custom logic — it just serves whatever static files
subsystem A places under its web root, following the layout below. This
document specifies only that layout and its file formats: the contract that
lets A and B be designed, built, and evolve independently.

Each subsystem gets its own design spec and implementation plan, written
separately after this one is approved.

## Goals

- Define a directory/URL layout that a plain static file server (no backend
  code) can serve as-is.
- Support multiple retained versions per plugin, including prereleases —
  exactly how many versions are retained is a policy decision for subsystem
  A, but the format must be able to represent any number of them.
- Let the Obsidian-side client discover which plugins are available without
  the user needing to know or type an exact repository path (browse a
  registry, not guess a URL).
- Reuse Obsidian's native `manifest.json` format unchanged, and mirror the
  same release-asset conventions BRAT already uses (`manifest.json`,
  `main.js`, `styles.css` optional, `manifest-beta.json` optional), so the
  installer's fetch/install logic can closely follow BRAT's existing,
  proven approach.

## Non-goals (deferred to subsystem specs)

- Access control / TLS on the nginx server — assumed to run on a trusted
  internal network; if needed, it's an nginx configuration concern
  orthogonal to this file format.
- Retention policy (how many versions to keep, when to prune) — subsystem
  A's responsibility. This spec only requires that whatever versions exist
  are correctly listed.
- The tracked-plugin config file format and Docker packaging process —
  subsystem A.
- The Obsidian plugin's UI/UX flows (browsing, adding, update-checking,
  settings) — subsystem B.
- File integrity verification (checksums/signatures). Not in v1; noted as a
  possible future addition that would slot into the version entry format
  below without breaking it.
- Delta/incremental updates. Every version's files are always served in
  full.

## Directory & URL layout

Given a configurable base URL (e.g. `https://plugins.internal.example.com/`),
everything below it follows a fixed structure:

```
<base_url>/
├── index.json                          # registry of all mirrored plugins
└── plugins/
    └── <owner>/<repo>/
        ├── versions.json                # version history for this plugin
        └── <version>/
            ├── manifest.json
            ├── main.js
            ├── styles.css               (optional)
            └── manifest-beta.json       (optional)
```

- `<owner>/<repo>` reuses the plugin's GitHub identifier verbatim as the
  directory path. This keeps mirrored content traceable back to its source
  and avoids name collisions between unrelated plugins that might share a
  short name. GitHub repository names are assumed to already be
  URL-path-safe (alphanumeric, `-`, `_`, `.`), so no additional encoding is
  applied.
- `<version>` is the release tag name, used verbatim as a path segment.
- No directory listing (`autoindex`) is required — the client always
  requests known file paths, never browses a directory. Standard nginx
  static-file serving with default MIME types is sufficient (`.json` as
  `application/json`, `.js` as `text/javascript`, `.css` as `text/css`).

## File formats

### `index.json`

Top-level registry so the installer can present a list of installable
plugins without the user knowing a repo path in advance.

```json
{
  "generatedAt": "2026-07-23T00:00:00Z",
  "plugins": [
    {
      "id": "my-plugin-id",
      "name": "My Plugin",
      "author": "Some Author",
      "description": "What the plugin does",
      "repo": "owner/repo",
      "latestVersion": "1.2.3",
      "latestPrerelease": "1.3.0-beta.1"
    }
  ]
}
```

Field notes:
- `id` matches the `id` field inside that plugin's `manifest.json`.
- `repo` is the `owner/repo` string used to build the `plugins/<owner>/<repo>/`
  path.
- `latestVersion` is the newest non-prerelease version mirrored; `latestPrerelease`
  is the newest prerelease version mirrored, or omitted/`null` if none exist.
  Both are convenience fields — the authoritative source is each plugin's own
  `versions.json`.
- `generatedAt` records when the mirror-builder last produced this file.

### `plugins/<owner>/<repo>/versions.json`

Full version history for one plugin.

```json
{
  "repo": "owner/repo",
  "latest": "1.2.3",
  "versions": [
    {
      "version": "1.2.3",
      "prerelease": false,
      "publishedAt": "2026-07-01T12:00:00Z",
      "files": ["manifest.json", "main.js", "styles.css"]
    },
    {
      "version": "1.3.0-beta.1",
      "prerelease": true,
      "publishedAt": "2026-07-10T09:00:00Z",
      "files": ["manifest.json", "main.js", "manifest-beta.json"]
    }
  ]
}
```

Field notes:
- `versions` is sorted newest-first. Sort order follows the same rule BRAT's
  existing `githubUtils.ts` uses: compare coerced semver when both tags
  parse as versions; fall back to comparing `publishedAt` when a tag isn't
  valid semver (some plugin authors don't tag releases with strict semver).
- `prerelease` mirrors the GitHub release's prerelease flag and lets the
  client filter candidates based on the user's "include prereleases" setting.
- `files` lists exactly which files exist for that version, so the client
  never has to guess whether e.g. `styles.css` exists for a given release —
  it reads the list instead of probing with extra requests.
- `latest` is a convenience pointer to the newest non-prerelease entry in
  `versions` (equivalent to filtering `versions` by `prerelease: false` and
  taking the first element).

### `manifest.json` / `main.js` / `styles.css` / `manifest-beta.json`

Copied byte-for-byte from the corresponding GitHub release asset. No
transformation. `manifest.json` remains Obsidian's native plugin manifest
schema (`id`, `name`, `version`, `minAppVersion`, `description`, `author`,
etc.) — this project does not extend or wrap it.

## Update-check semantics (for subsystem B to implement against)

1. Client fetches `plugins/<owner>/<repo>/versions.json` for an installed
   plugin.
2. Candidate set = all entries, filtered to `prerelease: false` unless the
   user has opted into prereleases for that plugin.
3. Pick the newest candidate by the same semver-with-fallback comparison
   described above.
4. If newer than the currently installed version, download that version's
   files from `plugins/<owner>/<repo>/<version>/` and install.

A known limitation: if subsystem A's retention policy has pruned the exact
version currently installed in a vault, that version's folder will 404. This
only affects showing "what version am I on" style diffs, not the
install/update flow itself, and is acceptable for v1.

## Known limitation carried from BRAT

Non-semver release tags exist in the wild (see BRAT issues #105, #114); the
fallback-to-`publishedAt` comparison rule exists specifically to keep
behavior consistent with what BRAT already does, so plugins that already
work with BRAT continue to sort/update correctly under this format.
