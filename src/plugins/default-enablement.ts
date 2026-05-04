export type PluginDefaultEnablement = {
  enabledByDefault?: boolean;
  enabledByDefaultOnPlatforms?: readonly string[];
};

export function isPluginEnabledByDefaultForPlatform(
  plugin: PluginDefaultEnablement,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (plugin.enabledByDefault === true) {
    return true;
  }
  return plugin.enabledByDefaultOnPlatforms?.includes(platform) === true;
}
