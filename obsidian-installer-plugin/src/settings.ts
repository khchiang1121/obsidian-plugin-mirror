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
}

export const DEFAULT_SETTINGS: PluginSettings = {
  mirrorBaseUrl: '',
  autoCheckOnStartup: true,
  autoInstallUpdates: true,
  trackedPlugins: {},
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
