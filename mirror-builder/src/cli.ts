import { join } from 'node:path';
import { loadConfig, ConfigError, type PluginConfigEntry } from './config.js';
import { createGithubClient, fetchReleasesForRepos, type RepoFetchResult } from './github.js';
import { sortReleasesNewestFirst, applyRetention } from './versionSort.js';
import { validateRelease, ensureVersionAssets, pruneStaleVersionDirs, type ValidatedVersion } from './assets.js';
import { readManifestMetadata } from './manifestReader.js';
import { writeVersionsJson, writeIndexJson, type IndexJsonEntry, type VersionEntry } from './writer.js';

export interface CliOptions {
  configPath: string;
  outDir: string;
  githubToken?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: './tracked-plugins.json',
    outDir: './dist',
    githubToken: process.env.GITHUB_TOKEN,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') options.configPath = argv[++i];
    else if (argv[i] === '--out') options.outDir = argv[++i];
  }
  return options;
}

interface PluginResult {
  entry?: IndexJsonEntry;
  warnings: string[];
}

async function processPlugin(
  entry: PluginConfigEntry,
  defaultRetain: number | 'all',
  defaultMinStableRetain: number,
  releasesResult: RepoFetchResult,
  outDir: string,
  token?: string
): Promise<PluginResult> {
  const warnings: string[] = [];
  if (releasesResult.status === 'error') {
    warnings.push(`Skipping ${entry.repo}: failed to fetch releases (${releasesResult.error.message})`);
    return { warnings };
  }

  const validated: ValidatedVersion[] = [];
  for (const release of releasesResult.releases) {
    const v = validateRelease(release);
    if (!v) {
      warnings.push(`Skipping ${entry.repo}@${release.tagName}: missing required asset (manifest.json/main.js)`);
      continue;
    }
    validated.push(v);
  }

  if (validated.length === 0) {
    warnings.push(`Skipping ${entry.repo}: no valid versions found`);
    return { warnings };
  }

  const sorted = sortReleasesNewestFirst(validated);
  const retain = entry.retain ?? defaultRetain;
  const minStableRetain = entry.minStableRetain ?? defaultMinStableRetain;
  const retained = applyRetention(sorted, retain, minStableRetain);

  const pluginDir = join(outDir, 'plugins', entry.repo);
  for (const version of retained) {
    await ensureVersionAssets(pluginDir, version, token);
  }
  pruneStaleVersionDirs(pluginDir, retained.map((v) => v.version));

  const versionEntries: VersionEntry[] = retained.map((v) => ({
    version: v.version,
    prerelease: v.prerelease,
    publishedAt: v.publishedAt,
    files: v.files,
  }));
  const latestStable = retained.find((v) => !v.prerelease) ?? null;
  const latestPrereleaseVersion = retained.find((v) => v.prerelease) ?? null;

  writeVersionsJson(outDir, entry.repo, {
    repo: entry.repo,
    latest: latestStable ? latestStable.version : null,
    versions: versionEntries,
  });

  const metadataSource = latestStable ?? retained[0];
  const manifestPath = join(pluginDir, metadataSource.version, 'manifest.json');
  let metadata;
  try {
    metadata = readManifestMetadata(manifestPath);
  } catch (error) {
    warnings.push(`Skipping ${entry.repo}: ${(error as Error).message}`);
    return { warnings };
  }

  return {
    warnings,
    entry: {
      id: metadata.id,
      name: metadata.name,
      author: metadata.author ?? entry.repo.split('/')[0],
      description: metadata.description,
      repo: entry.repo,
      latestVersion: latestStable ? latestStable.version : null,
      latestPrerelease: latestPrereleaseVersion ? latestPrereleaseVersion.version : null,
    },
  };
}

export async function run(options: CliOptions): Promise<number> {
  let config;
  try {
    config = loadConfig(options.configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Fatal: ${error.message}`);
      return 1;
    }
    throw error;
  }

  if (!options.githubToken) {
    console.warn('No GITHUB_TOKEN set — using anonymous GitHub API access (60 requests/hour).');
  }

  const client = createGithubClient(options.githubToken);
  const repos = config.plugins.map((p) => p.repo);
  const releasesByRepo = await fetchReleasesForRepos(client, repos);

  const indexEntries: IndexJsonEntry[] = [];
  const allWarnings: string[] = [];

  for (const plugin of config.plugins) {
    const result = await processPlugin(
      plugin,
      config.defaultRetain,
      config.defaultMinStableRetain,
      releasesByRepo.get(plugin.repo)!,
      options.outDir,
      options.githubToken
    );
    allWarnings.push(...result.warnings);
    if (result.entry) indexEntries.push(result.entry);
  }

  writeIndexJson(options.outDir, indexEntries);

  console.log(`Mirrored ${indexEntries.length}/${config.plugins.length} plugins.`);
  for (const warning of allWarnings) console.warn(`Warning: ${warning}`);

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
