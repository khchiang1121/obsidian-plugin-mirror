import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchedRelease } from './github.js';

export const REQUIRED_ASSET_NAMES = ['manifest.json', 'main.js'] as const;
export const OPTIONAL_ASSET_NAMES = ['styles.css', 'manifest-beta.json'] as const;

export interface ValidatedVersion {
  version: string;
  prerelease: boolean;
  publishedAt: string;
  files: string[];
  assetUrls: Record<string, string>;
}

export function validateRelease(release: FetchedRelease): ValidatedVersion | null {
  const assetsByName = new Map(release.assets.map((a) => [a.name, a.downloadUrl]));
  for (const required of REQUIRED_ASSET_NAMES) {
    if (!assetsByName.has(required)) return null;
  }
  const files = [...REQUIRED_ASSET_NAMES, ...OPTIONAL_ASSET_NAMES].filter((name) =>
    assetsByName.has(name)
  );
  const assetUrls: Record<string, string> = {};
  for (const file of files) assetUrls[file] = assetsByName.get(file)!;
  return {
    version: release.tagName,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    files,
    assetUrls,
  };
}

export function isVersionDirComplete(versionDir: string, expectedFiles: string[]): boolean {
  return expectedFiles.every((file) => existsSync(join(versionDir, file)));
}

export type Downloader = (url: string, destPath: string, token?: string) => Promise<void>;

export async function downloadFile(url: string, destPath: string, token?: string): Promise<void> {
  const headers: Record<string, string> = { Accept: 'application/octet-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destPath, buffer);
}

export async function ensureVersionAssets(
  pluginDir: string,
  version: ValidatedVersion,
  token?: string,
  downloader: Downloader = downloadFile
): Promise<'skipped' | 'downloaded'> {
  const versionDir = join(pluginDir, version.version);
  if (existsSync(versionDir) && isVersionDirComplete(versionDir, version.files)) {
    return 'skipped';
  }
  mkdirSync(versionDir, { recursive: true });
  for (const file of version.files) {
    await downloader(version.assetUrls[file], join(versionDir, file), token);
  }
  return 'downloaded';
}

export function pruneStaleVersionDirs(pluginDir: string, retainedVersions: string[]): string[] {
  if (!existsSync(pluginDir)) return [];
  const retainedSet = new Set(retainedVersions);
  const removed: string[] = [];
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !retainedSet.has(entry.name)) {
      rmSync(join(pluginDir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}
