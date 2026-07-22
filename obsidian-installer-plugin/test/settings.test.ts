import { describe, it, expect } from 'vitest';
import { mergeSettings, DEFAULT_SETTINGS } from '../src/settings';

describe('mergeSettings', () => {
  it('returns defaults when nothing was loaded', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('overrides only the fields present in the loaded data', () => {
    const merged = mergeSettings({ mirrorBaseUrl: 'https://plugins.internal.example.com/' });
    expect(merged.mirrorBaseUrl).toBe('https://plugins.internal.example.com/');
    expect(merged.autoCheckOnStartup).toBe(DEFAULT_SETTINGS.autoCheckOnStartup);
    expect(merged.autoInstallUpdates).toBe(DEFAULT_SETTINGS.autoInstallUpdates);
  });

  it('preserves loaded trackedPlugins entries', () => {
    const merged = mergeSettings({
      trackedPlugins: {
        'my-plugin-id': { repo: 'acme/my-plugin', installedVersion: '1.0.0', allowPrerelease: true },
      },
    });
    expect(merged.trackedPlugins['my-plugin-id']).toEqual({
      repo: 'acme/my-plugin',
      installedVersion: '1.0.0',
      allowPrerelease: true,
    });
  });
});
