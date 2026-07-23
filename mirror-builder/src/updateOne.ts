import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processPlugin } from './cli.js';
import { createGithubClient, fetchReleasesForRepo, type RepoFetchResult } from './github.js';
import { writeIndexJson, type IndexJsonEntry } from './writer.js';

export interface UpdateOneOptions {
  repo: string;
  outDir: string;
  retain: number | 'all';
  minStableRetain: number;
  githubToken?: string;
}

export function parseArgs(argv: string[]): UpdateOneOptions {
  const options: UpdateOneOptions = {
    repo: '',
    outDir: './dist',
    retain: 5,
    minStableRetain: 0,
    githubToken: process.env.GITHUB_TOKEN,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') options.repo = argv[++i];
    else if (argv[i] === '--out') options.outDir = argv[++i];
    else if (argv[i] === '--retain') {
      const value = argv[++i];
      options.retain = value === 'all' ? 'all' : Number(value);
    } else if (argv[i] === '--min-stable-retain') options.minStableRetain = Number(argv[++i]);
  }
  return options;
}

/**
 * Reads just the plugins array out of an existing index.json, so a
 * single-repo update can merge into it without needing to know or touch
 * anything about the other entries already written there by a full
 * mirror-builder run. Missing or malformed index.json is treated as empty
 * rather than fatal — a single-repo update should still be able to seed a
 * fresh dist/ directory.
 */
export function readExistingIndex(outDir: string): IndexJsonEntry[] {
  const indexPath = join(outDir, 'index.json');
  if (!existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as { plugins?: IndexJsonEntry[] };
    return Array.isArray(parsed.plugins) ? parsed.plugins : [];
  } catch {
    return [];
  }
}

/**
 * Replaces (or removes, or appends) the one entry matching repo, leaving
 * every other entry exactly as it was — the core guarantee that lets this
 * tool update a single plugin's release without re-processing, or even
 * being aware of, the rest of the tracked list.
 */
export function mergeIndexEntry(
  existing: IndexJsonEntry[],
  repo: string,
  updated: IndexJsonEntry | undefined
): IndexJsonEntry[] {
  const withoutRepo = existing.filter((e) => e.repo.toLowerCase() !== repo.toLowerCase());
  return updated ? [...withoutRepo, updated] : withoutRepo;
}

export async function run(options: UpdateOneOptions): Promise<number> {
  if (!options.repo) {
    console.error('Fatal: --repo <owner/repo> is required');
    return 1;
  }

  if (!options.githubToken) {
    console.warn('No GITHUB_TOKEN set — using anonymous GitHub API access (60 requests/hour).');
  }

  const client = createGithubClient(options.githubToken);
  let releasesResult: RepoFetchResult;
  try {
    const releases = await fetchReleasesForRepo(client, options.repo);
    releasesResult = { status: 'ok', releases };
  } catch (error) {
    releasesResult = { status: 'error', error: error as Error };
  }

  const result = await processPlugin(
    { repo: options.repo },
    options.retain,
    options.minStableRetain,
    releasesResult,
    options.outDir,
    options.githubToken
  );

  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);

  if (!result.entry) {
    console.error(`Failed to update ${options.repo} — no valid release found.`);
    return 1;
  }

  const existing = readExistingIndex(options.outDir);
  const merged = mergeIndexEntry(existing, options.repo, result.entry);
  writeIndexJson(options.outDir, merged);

  console.log(`Updated ${options.repo} to v${result.entry.latestVersion ?? result.entry.latestPrerelease} in ${options.outDir}/index.json (${merged.length} total plugins).`);
  return 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const exitCode = await run(options);
  process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
