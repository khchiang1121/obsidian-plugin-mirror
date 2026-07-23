import { readFileSync, writeFileSync } from 'node:fs';

const COMMUNITY_PLUGINS_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
const COMMUNITY_PLUGIN_STATS_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json';

export interface CommunityPlugin {
  id: string;
  name: string;
  author: string;
  repo: string;
}

export interface CommunityPluginStats {
  downloads: number;
}

export interface RankedPlugin {
  repo: string;
  name: string;
  id: string;
  downloads: number;
}

export interface MovedMatch {
  rankedRepo: string;
  trackedRepo: string;
  name: string;
}

export interface ComputeAdditionsResult {
  toAdd: RankedPlugin[];
  likelyMoved: MovedMatch[];
}

export interface TrackedConfig {
  defaultRetain: unknown;
  defaultMinStableRetain?: unknown;
  plugins: Array<{ repo: string; [key: string]: unknown }>;
}

export function rankByDownloads(
  communityPlugins: CommunityPlugin[],
  stats: Record<string, CommunityPluginStats>
): RankedPlugin[] {
  return communityPlugins
    .map((p) => ({ repo: p.repo, name: p.name, id: p.id, downloads: stats[p.id]?.downloads ?? 0 }))
    .sort((a, b) => b.downloads - a.downloads);
}

function repoOwnerless(repo: string): string {
  return repo.split('/')[1]?.toLowerCase() ?? '';
}

/**
 * Splits the top-N ranked plugins into ones to add and ones that are
 * "likely moved" — same repo name, different owner, matching an already
 * tracked repo. A plugin's GitHub repo sometimes transfers to a new owner
 * (maintainer handoff); without this check, a moved repo would get added
 * as a brand-new entry alongside its now-stale original, double-tracking
 * the same plugin.
 */
export function computeAdditions(
  trackedRepos: string[],
  ranked: RankedPlugin[],
  topN: number
): ComputeAdditionsResult {
  const trackedSet = new Set(trackedRepos.map((r) => r.toLowerCase()));
  const trackedByOwnerlessName = new Map<string, string>();
  for (const repo of trackedRepos) {
    trackedByOwnerlessName.set(repoOwnerless(repo), repo);
  }

  const toAdd: RankedPlugin[] = [];
  const likelyMoved: MovedMatch[] = [];

  for (const candidate of ranked.slice(0, topN)) {
    if (trackedSet.has(candidate.repo.toLowerCase())) continue;

    const existingRepo = trackedByOwnerlessName.get(repoOwnerless(candidate.repo));
    if (existingRepo) {
      likelyMoved.push({ rankedRepo: candidate.repo, trackedRepo: existingRepo, name: candidate.name });
      continue;
    }

    toAdd.push(candidate);
  }

  return { toAdd, likelyMoved };
}

/**
 * Mutates and returns config.plugins: appends every entry in toAdd, and —
 * only when replaceMoved is true — swaps a likely-moved tracked repo's
 * string in place for its new owner. Additive by default; never removes
 * anything unless replaceMoved is explicitly requested.
 */
export function applySync(
  config: TrackedConfig,
  result: ComputeAdditionsResult,
  replaceMoved: boolean
): { config: TrackedConfig; addedCount: number; replacedCount: number } {
  let addedCount = 0;
  let replacedCount = 0;

  for (const plugin of result.toAdd) {
    config.plugins.push({ repo: plugin.repo });
    addedCount++;
  }

  if (replaceMoved) {
    for (const moved of result.likelyMoved) {
      const entry = config.plugins.find((p) => p.repo.toLowerCase() === moved.trackedRepo.toLowerCase());
      if (entry) {
        entry.repo = moved.rankedRepo;
        replacedCount++;
      }
    }
  }

  return { config, addedCount, replacedCount };
}

export async function fetchCommunityPluginsData(fetchFn: typeof fetch = fetch): Promise<{
  plugins: CommunityPlugin[];
  stats: Record<string, CommunityPluginStats>;
}> {
  const [pluginsRes, statsRes] = await Promise.all([fetchFn(COMMUNITY_PLUGINS_URL), fetchFn(COMMUNITY_PLUGIN_STATS_URL)]);
  if (!pluginsRes.ok) {
    throw new Error(`Failed to fetch community-plugins.json: ${pluginsRes.status}`);
  }
  if (!statsRes.ok) {
    throw new Error(`Failed to fetch community-plugin-stats.json: ${statsRes.status}`);
  }
  const plugins = (await pluginsRes.json()) as CommunityPlugin[];
  const stats = (await statsRes.json()) as Record<string, CommunityPluginStats>;
  return { plugins, stats };
}

export interface SyncOptions {
  configPath: string;
  topN: number;
  replaceMoved: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): SyncOptions {
  const options: SyncOptions = {
    configPath: './tracked-plugins.json',
    topN: 200,
    replaceMoved: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') options.configPath = argv[++i];
    else if (argv[i] === '--top') options.topN = Number(argv[++i]);
    else if (argv[i] === '--replace-moved') options.replaceMoved = true;
    else if (argv[i] === '--dry-run') options.dryRun = true;
  }
  return options;
}

export async function run(options: SyncOptions): Promise<number> {
  const raw = readFileSync(options.configPath, 'utf-8');
  const config = JSON.parse(raw) as TrackedConfig;
  const trackedRepos = config.plugins.map((p) => p.repo);

  const { plugins, stats } = await fetchCommunityPluginsData();
  const ranked = rankByDownloads(plugins, stats);
  const result = computeAdditions(trackedRepos, ranked, options.topN);

  console.log(
    `Top ${options.topN} by downloads: ${result.toAdd.length} new, ${result.likelyMoved.length} already tracked under a different repo.`
  );
  for (const p of result.toAdd) {
    console.log(`  + ${p.repo}  (${p.name}, ${p.downloads.toLocaleString()} downloads)`);
  }
  if (result.likelyMoved.length > 0) {
    console.log(
      options.replaceMoved
        ? 'Replacing stale repos:'
        : 'Skipped as likely-moved (re-run with --replace-moved to update these in place):'
    );
    for (const moved of result.likelyMoved) {
      console.log(`  ${moved.trackedRepo} -> ${moved.rankedRepo}  (${moved.name})`);
    }
  }

  const nothingToAdd = result.toAdd.length === 0;
  const nothingToReplace = !options.replaceMoved || result.likelyMoved.length === 0;
  if (nothingToAdd && nothingToReplace) {
    console.log('Nothing to do.');
    return 0;
  }

  if (options.dryRun) {
    console.log('Dry run — no changes written.');
    return 0;
  }

  const { config: updated, addedCount, replacedCount } = applySync(config, result, options.replaceMoved);
  writeFileSync(options.configPath, JSON.stringify(updated, null, 2) + '\n');
  console.log(
    `Wrote ${options.configPath}: +${addedCount} added${options.replaceMoved ? `, ${replacedCount} repo(s) replaced` : ''}.`
  );
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
