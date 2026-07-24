# 🪞 Obsidian Plugin Mirror

**Run a fully offline, GitHub-free plugin store for Obsidian — inside your own network, with 200+ popular plugins ready to go.**

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is the standard way to install community/beta Obsidian plugins — but it talks straight to GitHub, which is a dead end on an air-gapped or restricted corporate network. This project is the fix: a self-hosted mirror plus an Obsidian plugin that browses, installs, and updates from it, with **zero calls to `github.com`, ever.**

<img src="docs/screenshots/settings-tab.png" alt="Mirror Installer settings tab inside Obsidian, showing installed plugins with update/advanced/remove actions and a searchable list of everything else available on the mirror" width="720">

## Why you'll want this

- 🔒 **Fully offline.** Browsing, installing, and updating plugins all happen over your own network — the mirror and the plugin both stay off GitHub entirely.
- 📦 **200+ plugins ready on day one.** `tracked-plugins.json` comes pre-filled with the top 200 community plugins by download count.
- 🚀 **Up and running with one `docker run`.** Pull the pre-built image, or build your own from source — either way it's just static files served by nginx.
- 🔁 **Updates itself.** The installer plugin checks for and installs updates to your mirrored plugins, and to its own code, from the same settings tab.
- 🧠 **Stays in sync automatically.** Install a plugin some other way (Obsidian's built-in browser, BRAT, a manual copy) and it gets picked up; remove one through Obsidian's own UI and it stops being tracked here too.
- 🎛️ **Prerelease opt-in lives under Advanced**, separate from the main list, so it's not confused with an enable/disable toggle.

## Quick start

### 1. Run the mirror

```bash
docker run -d --name plugin-mirror -p 8087:80 khchiang1121/obsidian-plugin-mirror:v20260723-top200-1.0.12
curl http://localhost:8087/health   # -> ok
```

Pre-built image on Docker Hub — [`khchiang1121/obsidian-plugin-mirror`](https://hub.docker.com/r/khchiang1121/obsidian-plugin-mirror) — with all 208 tracked plugins already baked in.

### 2. Install the vault plugin

```bash
mkdir -p <vault>/.obsidian/plugins/obsidian-mirror-installer
cd <vault>/.obsidian/plugins/obsidian-mirror-installer
curl -O http://localhost:8087/self/manifest.json
curl -O http://localhost:8087/self/main.js
```

No mirror running yet, or just have GitHub access on this machine? Grab the same two files from the [latest release](https://github.com/khchiang1121/obsidian-plugin-mirror/releases/latest) instead:

```bash
curl -LO https://github.com/khchiang1121/obsidian-plugin-mirror/releases/latest/download/manifest.json
curl -LO https://github.com/khchiang1121/obsidian-plugin-mirror/releases/latest/download/main.js
```

Enable **Mirror Installer** from Obsidian's Community Plugins settings, then set **Mirror base URL** to your mirror's address (e.g. `http://plugin-mirror.internal:8087/`). Future updates to the installer plugin itself show up in that same settings tab.

Want to customize which plugins are mirrored, or avoid Docker Hub entirely? See "Building your own image" below.

## Building your own image

Skip this if the public image above already covers the plugins you need. Build your own if you want to change `tracked-plugins.json`, or don't want to pull from Docker Hub in the first place.

```bash
git clone https://github.com/khchiang1121/obsidian-plugin-mirror.git
cd obsidian-plugin-mirror/mirror-builder
npm install
export GITHUB_TOKEN=ghp_xxx   # optional, raises the GitHub API rate limit from 60 to 5000/hr

# tracked-plugins.json already ships with ~200 popular plugins pre-filled —
# edit it to add/remove repos, or leave it as-is.
npm run generate -- --config tracked-plugins.json --out dist
docker build -t obsidian-plugin-mirror -f Dockerfile ..
docker run -d --name plugin-mirror -p 8087:80 obsidian-plugin-mirror
```

`npm run generate` is the only npm step — `docker build` compiles the vault plugin from source internally, nothing else to install or build by hand. (Note the `..` — the build context is the repo root, not `mirror-builder/`, since the image also bundles `docs/`.) Re-running `generate` later only fetches what changed, never everything from scratch.

## How it fits together

Two independent subsystems, connected only by a shared static-file format — either side can be rebuilt independently as long as it honors that format:

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

- **[`mirror-builder/`](mirror-builder)** — a one-shot CLI, run outside the restricted network. Reads a list of tracked GitHub repos, fetches their releases, and lays the result out as static files ready to be baked into an nginx Docker image. See the [design spec](docs/superpowers/specs/2026-07-23-mirror-builder-design.md).
- **[`obsidian-installer-plugin/`](obsidian-installer-plugin)** — a standard Obsidian community plugin, run inside the restricted network. Browses the mirror's registry, installs/removes mirrored plugins, checks for/applies updates, and updates itself — never talks to GitHub. See the [design spec](docs/superpowers/specs/2026-07-23-obsidian-installer-plugin-design.md).
- **[shared format spec](docs/superpowers/specs/2026-07-23-mirror-format-design.md)** — the directory layout and JSON schemas (`index.json`, `versions.json`) that are the only contract between the two subsystems.

The same nginx container also serves:
- `/health` — a plain `200 ok`, independent of the mirror content, for orchestrator/load-balancer liveness checks. The image also declares a Docker `HEALTHCHECK` against it.
- `/docs/` — this project's documentation site, bundled into the image so it's reachable from inside the restricted network too, not just via GitHub Pages.
- `/self/manifest.json` and `/self/main.js` — the installer plugin's own current build, always freshly compiled from source at image-build time (see "Install the vault plugin" above).

📖 **Full documentation:** [`docs/index.html`](docs/index.html) (also served at `/docs/` by your running mirror) has a fuller overview, architecture notes, and a changelog. Design specs and implementation plans for both subsystems live under [`docs/superpowers/`](docs/superpowers).

## Operating your own build

Only relevant if you built your own image above (the public Docker Hub image is updated the same way, just by the maintainer). `mirror-builder`'s npm-based CLI is for anyone running their own mirror over time, not just people modifying this codebase.

#### Keeping `tracked-plugins.json` current

```bash
cd mirror-builder
npm run sync-top-plugins -- --top 200          # add any new top-200-by-downloads plugins, additive only
npm run sync-top-plugins -- --top 200 --dry-run # preview without writing
npm run sync-top-plugins -- --replace-moved     # also update repos that transferred to a new owner
```

Ranks Obsidian's community plugins by download count (from `community-plugins.json` / `community-plugin-stats.json` in [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)) and appends any not already tracked. It never removes an existing entry — a plugin whose repo appears to have moved (same repo name, different owner) is only reported, not swapped, unless you pass `--replace-moved`.

After editing `tracked-plugins.json`, just re-run `npm run generate` and `docker build` (see "Building your own image" above) — re-running `generate` only fetches what changed and prunes anything that fell outside retention, never everything from scratch.

## Contributing

Each subsystem is an independent npm package with its own test suite:

```bash
cd mirror-builder && npm test              # 61 tests, vitest
cd obsidian-installer-plugin && npm test   # 77 tests, vitest
```

For active development on the vault plugin itself:

```bash
cd obsidian-installer-plugin
npm install
npm run dev     # watches src/, rebuilds main.js on change
npm run build   # typechecks, then bundles src/main.ts -> main.js (one-shot)
```

`obsidian-installer-plugin/` is deliberately **not** listed in `tracked-plugins.json` — releasing a new version of it shouldn't require (or trigger) re-fetching every other tracked plugin. Every `docker build` compiles it from source and serves it at `/self/manifest.json` / `/self/main.js` (see "How it fits together" above), so there's no separate release step to run.
