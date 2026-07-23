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
