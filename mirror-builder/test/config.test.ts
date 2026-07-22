import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const fixture = (name: string) => new URL(`./fixtures/config/${name}`, import.meta.url).pathname;

describe('loadConfig', () => {
  it('parses a valid config file', () => {
    const config = loadConfig(fixture('valid.json'));
    expect(config.defaultRetain).toBe(5);
    expect(config.plugins).toEqual([
      { repo: 'acme/plugin-one', retain: undefined },
      { repo: 'acme/plugin-two', retain: 10 },
      { repo: 'acme/plugin-three', retain: 'all' },
    ]);
  });

  it('throws ConfigError when the file does not exist', () => {
    expect(() => loadConfig(fixture('does-not-exist.json'))).toThrow(ConfigError);
  });

  it('throws ConfigError when the file is not valid JSON', () => {
    expect(() => loadConfig(fixture('not-json.txt'))).toThrow(ConfigError);
  });

  it('throws ConfigError when plugins is empty', () => {
    expect(() => loadConfig(fixture('empty-plugins.json'))).toThrow(ConfigError);
  });

  it('throws ConfigError when a repo string is malformed', () => {
    expect(() => loadConfig(fixture('invalid-repo.json'))).toThrow(ConfigError);
  });

  it('throws ConfigError when retain is not a positive integer or "all"', () => {
    expect(() => loadConfig(fixture('invalid-retain.json'))).toThrow(ConfigError);
  });
});
