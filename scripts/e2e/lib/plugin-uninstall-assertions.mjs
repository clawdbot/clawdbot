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
