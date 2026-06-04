/** Manifest fields that control default plugin enablement. */
export type PluginDefaultEnablement = {
  enabledByDefault?: boolean;
  enabledByDefaultOnPlatforms?: readonly string[];
};

/** True when a plugin should be enabled by default for a platform. */
export function isPluginEnabledByDefaultForPlatform(
  plugin: PluginDefaultEnablement,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (plugin.enabledByDefault === true) {
    return true;
  }
  return plugin.enabledByDefaultOnPlatforms?.includes(platform) === true;
}
