// Canonical path helpers for bundled plugin source and dist locations.
/** Root directory containing bundled plugin source packages. */
export const BUNDLED_PLUGIN_ROOT_DIR = "extensions";
/** Prefix for bundled plugin source paths. */
export const BUNDLED_PLUGIN_PATH_PREFIX = `${BUNDLED_PLUGIN_ROOT_DIR}/`;
/**
 * Return a bundled plugin source root path.
 * @internal Shared test-routing script contract.
 */
export function bundledPluginRoot(pluginId) {
  return `${BUNDLED_PLUGIN_PATH_PREFIX}${pluginId}`;
}

/** Return a bundled plugin source file path. */
export function bundledPluginFile(pluginId, relativePath) {
  return `${bundledPluginRoot(pluginId)}/${relativePath}`;
}

/** Return a bundled plugin dist root path. */
function bundledDistPluginRoot(pluginId) {
  return `dist/${bundledPluginRoot(pluginId)}`;
}

/** Return a bundled plugin dist file path. */
export function bundledDistPluginFile(pluginId, relativePath) {
  return `${bundledDistPluginRoot(pluginId)}/${relativePath}`;
}

/**
 * Return a bundled plugin source callsite string with a line number.
 * @internal Shared repository-script contract.
 */
export function bundledPluginCallsite(pluginId, relativePath, line) {
  return `${bundledPluginFile(pluginId, relativePath)}:${line}`;
}
