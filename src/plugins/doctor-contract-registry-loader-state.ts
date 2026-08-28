/** Shared loader state for plugin doctor contracts and test fixtures. */
import type { PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";

export const pluginDoctorContractRegistryLoaderState = {
  moduleLoaderFactory: undefined as PluginModuleLoaderFactory | undefined,
};
