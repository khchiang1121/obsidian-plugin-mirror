import { describe, it, expect } from 'vitest';
import { readManifestMetadata, ManifestError } from '../src/manifestReader.js';

const fixture = (name: string) => new URL(`./fixtures/manifests/${name}`, import.meta.url).pathname;

describe('readManifestMetadata', () => {
  it('extracts id/name/author/description from a valid manifest', () => {
    const metadata = readManifestMetadata(fixture('valid-manifest.json'));
    expect(metadata).toEqual({
      id: 'my-plugin-id',
      name: 'My Plugin',
      author: 'Some Author',
      description: 'What the plugin does',
    });
  });

  it('throws ManifestError when the file does not exist', () => {
    expect(() => readManifestMetadata(fixture('does-not-exist.json'))).toThrow(ManifestError);
  });

  it('throws ManifestError when a required field is missing', () => {
    expect(() => readManifestMetadata(fixture('missing-field-manifest.json'))).toThrow(ManifestError);
  });
});
