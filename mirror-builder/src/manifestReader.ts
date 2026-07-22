import { readFileSync } from 'node:fs';

export interface PluginMetadata {
  id: string;
  name: string;
  author: string;
  description: string;
}

export class ManifestError extends Error {}

export function readManifestMetadata(manifestPath: string): PluginMetadata {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    throw new ManifestError(`manifest.json not found at ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestError(`manifest.json at ${manifestPath} is not valid JSON`);
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of ['id', 'name', 'author', 'description'] as const) {
    if (typeof obj[field] !== 'string') {
      throw new ManifestError(`manifest.json at ${manifestPath} is missing required field "${field}"`);
    }
  }
  return {
    id: obj.id as string,
    name: obj.name as string,
    author: obj.author as string,
    description: obj.description as string,
  };
}
