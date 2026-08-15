// Resolves config path scope entries for installed plugin index records.
import type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
} from "./installed-plugin-index-types.js";

/** Compat code marking install records that need config-path activation metadata. */
export const CONFIG_PATH_ACTIVATION_COMPAT_CODE = "activation-config-path-hint";

function recordUsesConfigPathActivation(plugin: InstalledPluginIndexRecord): boolean {
  return plugin.compat.includes(CONFIG_PATH_ACTIVATION_COMPAT_CODE);
}

/** True when an index still has config-path activation records missing startup metadata. */
export function hasMissingConfigPathActivationMetadata(index: InstalledPluginIndex): boolean {
  return index.plugins.some(
    (plugin) => recordUsesConfigPathActivation(plugin) && plugin.startup.configPaths === undefined,
  );
}

/** True when a record migrated config-path activation startup metadata. */
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
