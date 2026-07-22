import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeVersionsJson, writeIndexJson } from '../src/writer.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mirror-builder-writer-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('writeVersionsJson', () => {
  it('writes versions.json under plugins/<owner>/<repo>/', () => {
    writeVersionsJson(tempDir, 'acme/plugin-one', {
      repo: 'acme/plugin-one',
      latest: '1.0.0',
      versions: [
        { version: '1.0.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z', files: ['manifest.json', 'main.js'] },
      ],
    });
    const written = JSON.parse(
      readFileSync(join(tempDir, 'plugins', 'acme', 'plugin-one', 'versions.json'), 'utf-8')
    );
    expect(written.repo).toBe('acme/plugin-one');
    expect(written.latest).toBe('1.0.0');
    expect(written.versions).toHaveLength(1);
  });
});

describe('writeIndexJson', () => {
  it('writes index.json with the given entries and generatedAt', () => {
    writeIndexJson(
      tempDir,
      [
        {
          id: 'my-plugin-id',
          name: 'My Plugin',
          author: 'Some Author',
          description: 'What the plugin does',
          repo: 'acme/plugin-one',
          latestVersion: '1.0.0',
          latestPrerelease: null,
        },
      ],
      '2026-07-23T00:00:00Z'
    );
    const written = JSON.parse(readFileSync(join(tempDir, 'index.json'), 'utf-8'));
    expect(written.generatedAt).toBe('2026-07-23T00:00:00Z');
    expect(written.plugins).toHaveLength(1);
    expect(written.plugins[0].id).toBe('my-plugin-id');
  });
});
