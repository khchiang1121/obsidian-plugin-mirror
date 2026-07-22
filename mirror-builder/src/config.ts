import { readFileSync } from 'node:fs';

export interface PluginConfigEntry {
  repo: string;
  retain?: number | 'all';
}

export interface TrackedPluginsConfig {
  defaultRetain: number | 'all';
  plugins: PluginConfigEntry[];
}

export class ConfigError extends Error {}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

function isValidRetain(value: unknown): value is number | 'all' {
  if (value === 'all') return true;
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function loadConfig(filePath: string): TrackedPluginsConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    throw new ConfigError(`Config file not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Config file is not valid JSON: ${filePath}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError('Config must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  if (!isValidRetain(obj.defaultRetain)) {
    throw new ConfigError('"defaultRetain" must be a positive integer or "all"');
  }

  if (!Array.isArray(obj.plugins) || obj.plugins.length === 0) {
    throw new ConfigError('"plugins" must be a non-empty array');
  }

  const plugins: PluginConfigEntry[] = obj.plugins.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigError(`plugins[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.repo !== 'string' || !REPO_PATTERN.test(e.repo)) {
      throw new ConfigError(`plugins[${i}].repo must be an "owner/repo" string`);
    }
    if (e.retain !== undefined && !isValidRetain(e.retain)) {
      throw new ConfigError(`plugins[${i}].retain must be a positive integer or "all"`);
    }
    return { repo: e.repo, retain: e.retain as number | 'all' | undefined };
  });

  return { defaultRetain: obj.defaultRetain, plugins };
}
