/** Shared loader state for plugin doctor contracts and test fixtures. */
import {
  createPluginModuleLoaderCache,
  type PluginModuleLoaderFactory,
} from "./plugin-module-loader-cache.js";

export const pluginDoctorContractRegistryLoaderState = {
  moduleLoaders: createPluginModuleLoaderCache(),
  moduleLoaderFactory: undefined as PluginModuleLoaderFactory | undefined,
};
