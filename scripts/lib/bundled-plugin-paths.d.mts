export const BUNDLED_PLUGIN_ROOT_DIR: "extensions";
export const BUNDLED_PLUGIN_PATH_PREFIX: "extensions/";
export function bundledPluginRoot(pluginId: string): string;
export function bundledPluginFile(pluginId: string, relativePath: string): string;
export function bundledDistPluginFile(pluginId: string, relativePath: string): string;
export function bundledPluginCallsite(pluginId: string, relativePath: string, line: number): string;
