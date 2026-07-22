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
docker run -d --name plugin-mirror -p 8080:80 obsidian-plugin-mirror
curl http://localhost:8080/index.json
```

Re-running `npm run build:image` only downloads what changed and prunes anything that fell outside retention — it never re-fetches everything from scratch.

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
cd mirror-builder && npm test              # 37 tests, vitest
cd obsidian-installer-plugin && npm test   # 30 tests, vitest
```

Design specs and implementation plans for both subsystems live under [`docs/superpowers/`](docs/superpowers).
