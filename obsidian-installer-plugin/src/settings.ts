export interface TrackedPlugin {
  repo: string;
  installedVersion: string;
  allowPrerelease: boolean;
  name?: string;
}

export interface PluginSettings {
  mirrorBaseUrl: string;
  autoCheckOnStartup: boolean;
  autoInstallUpdates: boolean;
  trackedPlugins: Record<string, TrackedPlugin>;
  showPenguin: boolean;
  penguinIgnoreReducedMotion: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  mirrorBaseUrl: '',
  autoCheckOnStartup: true,
  autoInstallUpdates: true,
  trackedPlugins: {},
  showPenguin: true,
  penguinIgnoreReducedMotion: false,
};

export function mergeSettings(loaded: Partial<PluginSettings> | null | undefined): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...loaded,
    trackedPlugins: {
      ...DEFAULT_SETTINGS.trackedPlugins,
      ...(loaded?.trackedPlugins ?? {}),
    },
  };
}
