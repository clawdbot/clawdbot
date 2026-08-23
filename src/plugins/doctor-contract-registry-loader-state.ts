/** Shared loader state for plugin doctor contracts and test fixtures. */
import { clearNativeRequireJavaScriptModuleCache } from "./native-module-require.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import {
  createPluginModuleLoaderCache,
  type PluginModuleLoaderFactory,
} from "./plugin-module-loader-cache.js";

export const pluginDoctorContractRegistryLoaderState = {
  moduleLoaders: createPluginModuleLoaderCache(),
  // Native exports outlive loader closures, so retain their owner roots for lifecycle eviction.
  moduleRoots: new Map<string, string>(),
  moduleLoaderFactory: undefined as PluginModuleLoaderFactory | undefined,
};

function clearPluginDoctorContractRegistryLoaderState(): void {
  pluginDoctorContractRegistryLoaderState.moduleLoaders.clear();
  for (const [modulePath, rootDir] of pluginDoctorContractRegistryLoaderState.moduleRoots) {
    clearNativeRequireJavaScriptModuleCache(modulePath, { dependencyRoot: rootDir });
  }
  pluginDoctorContractRegistryLoaderState.moduleRoots.clear();
}

registerPluginMetadataProcessMemoLifecycleClear(clearPluginDoctorContractRegistryLoaderState);
