/** Shared loader state for plugin setup registration and test fixtures. */
import type { PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";

export const pluginSetupRegistryLoaderState = {
  moduleLoaderFactory: undefined as PluginModuleLoaderFactory | undefined,
};
