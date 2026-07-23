# Obsidian Plugin Mirror

An internal, GitHub-free replacement for [BRAT](https://github.com/TfTHacker/obsidian42-brat), for Obsidian vaults running inside networks that can't reach GitHub.

BRAT installs beta plugins by talking directly to GitHub releases. That doesn't work on a restricted/offline corporate network. This project replaces the GitHub dependency with an internally-hosted static mirror, plus an Obsidian plugin that talks only to that mirror.

📖 **Full documentation:** see [`docs/index.html`](docs/index.html) (published via GitHub Pages) for an overview, or the design specs linked below for the full technical detail.

## How it fits together

Two independent subsystems, connected only by a shared static-file format:

```
┌────────────────────┐        static files        ┌──────────────────────────┐
│   mirror-builder    │ ──────────────────────────▶│   nginx (plain static)   │
│ (runs outside the    │   index.json               │  serves the mirror        │
│  restricted network) │   plugins/<owner>/<repo>/…  │                           │
└────────────────────┘                             └──────────────┬───────────┘
                                                                    │ HTTP only
                                                                    ▼
                                                    ┌──────────────────────────┐
                                                    │  Obsidian installer      │
                                                    │  plugin (runs inside     │
                                                    │  the restricted network) │
                                                    └──────────────────────────┘
```

- **[`mirror-builder/`](mirror-builder)** — a one-shot CLI, run outside the restricted network. Reads a list of tracked GitHub repos, fetches their releases, and lays the result out as static files ready to be baked into an nginx Docker image. Never depends on Docker or a scheduler itself — see the [design spec](docs/superpowers/specs/2026-07-23-mirror-builder-design.md).
- **[`obsidian-installer-plugin/`](obsidian-installer-plugin)** — a standard Obsidian community plugin, run inside the restricted network. Browses the mirror's registry, installs/removes mirrored plugins, and checks for/applies updates — never talks to GitHub. See the [design spec](docs/superpowers/specs/2026-07-23-obsidian-installer-plugin-design.md).
- **[shared format spec](docs/superpowers/specs/2026-07-23-mirror-format-design.md)** — the directory layout and JSON schemas (`index.json`, `versions.json`) that are the only contract between the two subsystems. Either side can be rebuilt independently as long as it honors this format.

## Quick start

### Build the mirror (`mirror-builder/`)

```bash
cd mirror-builder
npm install
cp tracked-plugins.example.json tracked-plugins.json   # then edit with real owner/repo entries
export GITHUB_TOKEN=ghp_xxx                             # optional, raises the GitHub API rate limit
npm run build:image                                      # fetches releases, then docker build
docker run --rm -d --name plugin-mirror -p 8087:80 obsidian-plugin-mirror
curl http://localhost:8087/index.json
```

Re-running `npm run build:image` only downloads what changed and prunes anything that fell outside retention — it never re-fetches everything from scratch.

The same nginx container also serves:
- `/health` — a plain `200 ok`, independent of the mirror content, for orchestrator/load-balancer liveness checks. The image also declares a Docker `HEALTHCHECK` against it.
- `/docs/` — this project's documentation site (`docs/index.html`), bundled into the image so it's reachable from inside the restricted network too, not just via GitHub Pages.
- `/self/manifest.json` and `/self/main.js` — the installer plugin's own current build (a dedicated Node build stage always compiles it from source, since `main.js` is gitignored). Fixed, version-less path: no `index.json` entry, no version history, since self-update only ever needs "the current build, right now." This is what the plugin's own self-update check reads.

#### Keeping `tracked-plugins.json` current

```bash
cd mirror-builder
npm run sync-top-plugins -- --top 200          # add any new top-200-by-downloads plugins, additive only
npm run sync-top-plugins -- --top 200 --dry-run # preview without writing
npm run sync-top-plugins -- --replace-moved     # also update repos that transferred to a new owner
```

Ranks Obsidian's community plugins by download count (from `community-plugins.json` / `community-plugin-stats.json` in [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)) and appends any not already tracked. It never removes an existing entry — a plugin whose repo appears to have moved (same repo name, different owner) is only reported, not swapped, unless you pass `--replace-moved`.

#### Why obsidian-installer-plugin isn't in tracked-plugins.json

`obsidian-installer-plugin/` is deliberately **not** listed in `tracked-plugins.json` and has no `index.json` entry — cutting a new build of it shouldn't require (or trigger) re-fetching all ~200 tracked open-source plugins, and self-update only ever needs "the current build, right now," not a version history. Every `docker build` compiles it from source and serves it at `/self/manifest.json` / `/self/main.js` (see above) — no separate release step.

The build context is the repo root (`..`, since `Dockerfile` lives in `mirror-builder/` but also bundles `docs/` — see below), not `mirror-builder/` itself.

### Install the vault plugin (`obsidian-installer-plugin/`)

```bash
cd obsidian-installer-plugin
npm install
npm run build   # typechecks, then bundles src/main.ts -> main.js
```

Copy `manifest.json`, `main.js`, and `versions.json` into `<vault>/.obsidian/plugins/obsidian-mirror-installer/`, enable the plugin from Obsidian's Community Plugins settings, then set **Mirror base URL** in the plugin's settings tab to your mirror's address (e.g. `http://plugin-mirror.internal:8080/`).

## Development

Each subsystem is an independent npm package with its own test suite:

```bash
cd mirror-builder && npm test              # 61 tests, vitest
cd obsidian-installer-plugin && npm test   # 69 tests, vitest
```

Design specs and implementation plans for both subsystems live under [`docs/superpowers/`](docs/superpowers).
