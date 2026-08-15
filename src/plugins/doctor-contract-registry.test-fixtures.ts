/** Test-only controls for plugin doctor contract loading. */
import { pluginDoctorContractRegistryLoaderState } from "./doctor-contract-registry-loader-state.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";

export function clearPluginDoctorContractRegistryCache(): void {
  clearPluginMetadataLifecycleCaches();
}

export function setPluginDoctorContractRegistryModuleLoaderFactoryForTest(
  factory: PluginModuleLoaderFactory | undefined,
): void {
  pluginDoctorContractRegistryLoaderState.moduleLoaderFactory = factory;
  clearPluginDoctorContractRegistryCache();
}
