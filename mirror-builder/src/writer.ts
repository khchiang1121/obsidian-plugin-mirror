import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VersionEntry {
  version: string;
  prerelease: boolean;
  publishedAt: string;
  files: string[];
}

export interface VersionsJson {
  repo: string;
  latest: string | null;
  versions: VersionEntry[];
}

export interface IndexJsonEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  latestVersion: string | null;
  latestPrerelease: string | null;
}

export interface IndexJson {
  generatedAt: string;
  plugins: IndexJsonEntry[];
}

export function writeVersionsJson(outDir: string, repo: string, data: VersionsJson): void {
  const pluginDir = join(outDir, 'plugins', repo);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'versions.json'), JSON.stringify(data, null, 2) + '\n');
}

export function writeIndexJson(
  outDir: string,
  entries: IndexJsonEntry[],
  generatedAt: string = new Date().toISOString()
): void {
  mkdirSync(outDir, { recursive: true });
  const index: IndexJson = { generatedAt, plugins: entries };
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
}
