/** Shared loader state for plugin setup registration and test fixtures. */
import {
  createPluginModuleLoaderCache,
  type PluginModuleLoaderFactory,
} from "./plugin-module-loader-cache.js";

export const pluginSetupRegistryLoaderState = {
  moduleLoaders: createPluginModuleLoaderCache(),
  moduleRoots: new Map<string, string>(),
  moduleLoaderFactory: undefined as PluginModuleLoaderFactory | undefined,
};
