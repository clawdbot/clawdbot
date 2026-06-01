import type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
} from "./installed-plugin-index-types.js";

export const CONFIG_PATH_ACTIVATION_COMPAT_CODE = "activation-config-path-hint";

function recordUsesConfigPathActivation(plugin: InstalledPluginIndexRecord): boolean {
  return plugin.compat.includes(CONFIG_PATH_ACTIVATION_COMPAT_CODE);
}

export function hasMissingConfigPathActivationMetadata(index: InstalledPluginIndex): boolean {
  return index.plugins.some(
    (plugin) => recordUsesConfigPathActivation(plugin) && plugin.startup.configPaths === undefined,
  );
}

export function hasConfigPathActivationMetadataMigration(params: {
  previous: InstalledPluginIndexRecord;
  current: InstalledPluginIndexRecord;
}): boolean {
  return (
    recordUsesConfigPathActivation(params.previous) &&
    params.previous.startup.configPaths === undefined &&
    params.current.startup.configPaths !== undefined
  );
}
