export function isExplicitPluginDisableMarker(config, pluginId) {
  const entry = config.plugins?.entries?.[pluginId];
  return (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    entry.enabled === false &&
    Object.keys(entry).length === 1
  );
}

export function hasExpectedPluginUninstallConfigState(config, pluginId) {
  if (isExplicitPluginDisableMarker(config, pluginId)) {
    return true;
  }
  // Only the source-qualified plugin harness can select this historical dialect.
  // Generic frozen-target authorization must not relax this package contract.
  return (
    process.env.OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE === "legacy" &&
    !Object.hasOwn(config.plugins?.entries ?? {}, pluginId)
  );
}
