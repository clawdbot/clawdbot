export const BUNDLED_PLUGIN_ROOT_DIR = "extensions";
export const BUNDLED_PLUGIN_PATH_PREFIX = `${BUNDLED_PLUGIN_ROOT_DIR}/`;
export const BUNDLED_PLUGIN_TEST_GLOB = `${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.ts`;

export function bundledPluginRoot(pluginId: string): string {
  return `${BUNDLED_PLUGIN_PATH_PREFIX}${pluginId}`;
}

export function bundledPluginFile(pluginId: string, relativePath: string): string {
  return `${bundledPluginRoot(pluginId)}/${relativePath}`;
}

function joinRoot(baseDir: string, relativePath: string): string {
  return `${baseDir.replace(/\/$/, "")}/${relativePath}`;
}

export function bundledPluginDirPrefix(pluginId: string, relativeDir: string): string {
  return `${bundledPluginRoot(pluginId)}/${relativeDir.replace(/\/$/, "")}/`;
}

export function bundledPluginRootAt(baseDir: string, pluginId: string): string {
  return joinRoot(baseDir, bundledPluginRoot(pluginId));
}

export function bundledPluginFileAt(
  baseDir: string,
  pluginId: string,
  relativePath: string,
): string {
  return joinRoot(baseDir, bundledPluginFile(pluginId, relativePath));
}

export function bundledDistPluginRoot(pluginId: string): string {
  return `dist/${bundledPluginRoot(pluginId)}`;
}

export function bundledDistPluginFile(pluginId: string, relativePath: string): string {
  return `${bundledDistPluginRoot(pluginId)}/${relativePath}`;
}

export function bundledDistPluginRootAt(baseDir: string, pluginId: string): string {
  return joinRoot(baseDir, bundledDistPluginRoot(pluginId));
}

export function bundledDistPluginFileAt(
  baseDir: string,
  pluginId: string,
  relativePath: string,
): string {
  return joinRoot(baseDir, bundledDistPluginFile(pluginId, relativePath));
}

export function installedPluginRoot(baseDir: string, pluginId: string): string {
  return bundledPluginRootAt(baseDir, pluginId);
}

export function repoInstallSpec(pluginId: string): string {
  return `./${bundledPluginRoot(pluginId)}`;
}
