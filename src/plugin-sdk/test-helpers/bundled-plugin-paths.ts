/** Source directory that contains bundled plugin packages. */
export const BUNDLED_PLUGIN_ROOT_DIR = "extensions";
/** Repo-relative prefix for files inside bundled plugin packages. */
export const BUNDLED_PLUGIN_PATH_PREFIX = `${BUNDLED_PLUGIN_ROOT_DIR}/`;
/** Glob that matches bundled plugin test files in source checkouts. */
export const BUNDLED_PLUGIN_TEST_GLOB = `${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.ts`;

/** Return the repo-relative source root for a bundled plugin id. */
export function bundledPluginRoot(pluginId: string): string {
  return `${BUNDLED_PLUGIN_PATH_PREFIX}${pluginId}`;
}

/** Return a repo-relative source file path inside a bundled plugin. */
export function bundledPluginFile(pluginId: string, relativePath: string): string {
  return `${bundledPluginRoot(pluginId)}/${relativePath}`;
}

function joinRoot(baseDir: string, relativePath: string): string {
  // Keep callers free to pass package roots with or without a trailing slash.
  return `${baseDir.replace(/\/$/, "")}/${relativePath}`;
}

/** Return a repo-relative source directory prefix inside a bundled plugin. */
export function bundledPluginDirPrefix(pluginId: string, relativeDir: string): string {
  return `${bundledPluginRoot(pluginId)}/${relativeDir.replace(/\/$/, "")}/`;
}

/** Return an absolute or caller-rooted bundled plugin source root. */
export function bundledPluginRootAt(baseDir: string, pluginId: string): string {
  return joinRoot(baseDir, bundledPluginRoot(pluginId));
}

/** Return an absolute or caller-rooted bundled plugin source file path. */
export function bundledPluginFileAt(
  baseDir: string,
  pluginId: string,
  relativePath: string,
): string {
  return joinRoot(baseDir, bundledPluginFile(pluginId, relativePath));
}

/** Return the repo-relative dist root for a bundled plugin id. */
export function bundledDistPluginRoot(pluginId: string): string {
  return `dist/${bundledPluginRoot(pluginId)}`;
}

/** Return a repo-relative dist file path inside a bundled plugin. */
export function bundledDistPluginFile(pluginId: string, relativePath: string): string {
  return `${bundledDistPluginRoot(pluginId)}/${relativePath}`;
}

/** Return an absolute or caller-rooted bundled plugin dist root. */
export function bundledDistPluginRootAt(baseDir: string, pluginId: string): string {
  return joinRoot(baseDir, bundledDistPluginRoot(pluginId));
}

/** Return an absolute or caller-rooted bundled plugin dist file path. */
export function bundledDistPluginFileAt(
  baseDir: string,
  pluginId: string,
  relativePath: string,
): string {
  return joinRoot(baseDir, bundledDistPluginFile(pluginId, relativePath));
}

/** Compatibility alias for installed bundled plugin roots under a package root. */
export function installedPluginRoot(baseDir: string, pluginId: string): string {
  return bundledPluginRootAt(baseDir, pluginId);
}

/** Return the local install spec used by tests for repo-owned bundled plugins. */
export function repoInstallSpec(pluginId: string): string {
  return `./${bundledPluginRoot(pluginId)}`;
}
