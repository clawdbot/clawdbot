/** Test-only controls for plugin setup registry loading. */
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";
import { pluginSetupRegistryLoaderState } from "./setup-registry-loader-state.js";

export function clearPluginSetupRegistryCache(): void {
  clearPluginMetadataLifecycleCaches();
}

export function setPluginSetupRegistryModuleLoaderFactoryForTest(
  factory: PluginModuleLoaderFactory | undefined,
): void {
  pluginSetupRegistryLoaderState.moduleLoaderFactory = factory;
  clearPluginSetupRegistryCache();
}
