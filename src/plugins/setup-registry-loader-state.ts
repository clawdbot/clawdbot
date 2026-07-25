/** Shared loader state for plugin setup registration and test fixtures. */
import {
  createPluginModuleLoaderCache,
  type PluginModuleLoaderFactory,
} from "./plugin-module-loader-cache.js";

export const pluginSetupRegistryLoaderState = {
  moduleLoaders: createPluginModuleLoaderCache(),
  moduleLoaderFactory: undefined as PluginModuleLoaderFactory | undefined,
};
