/** Shared loader state for plugin doctor contracts and test fixtures. */
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import {
  clearPluginModuleLoaderLifecycleCache,
  createPluginModuleLoaderCache,
  type PluginModuleLoaderFactory,
} from "./plugin-module-loader-cache.js";

export const pluginDoctorContractRegistryLoaderState = {
  moduleLoaders: createPluginModuleLoaderCache(),
  // Native exports outlive loader closures, so retain their owner roots for lifecycle eviction.
  moduleRoots: new Map<string, string>(),
  moduleLoaderFactory: undefined as PluginModuleLoaderFactory | undefined,
};

registerPluginMetadataProcessMemoLifecycleClear(() => {
  clearPluginModuleLoaderLifecycleCache(pluginDoctorContractRegistryLoaderState);
});
