/** Stable public facade for plugin loading and runtime-registry resolution. */
import { loadOpenClawPlugins } from "./loader-runtime-load.js";
import type { PluginLoadOptions } from "./loader-types.js";
export { resolveCompatibleRuntimePluginRegistry } from "./active-runtime-registry.js";
export {
  clearPluginRegistryLoadCache,
  isPluginRegistryLoadInFlight,
  resolvePluginRegistryLoadCacheKey,
} from "./loader-cache.js";
export { loadOpenClawPluginCliRegistry } from "./loader-cli-registry.js";
export {
  resolveRuntimePluginRegistry,
  acquirePluginRegistryForInspection,
} from "./loader-runtime-load.js";

/** Loads a caller-owned registry value without changing the process-wide active registry. */
export function loadPluginRegistryHandle(options: PluginLoadOptions = {}) {
  return loadOpenClawPlugins({ ...options, activate: false });
}

/** Loads and installs the registry owned by a process composition root. */
export function loadAndActivateRootPluginRegistry(options: PluginLoadOptions = {}) {
  return loadOpenClawPlugins({ ...options, activate: true });
}

export { loadOpenClawPlugins };
export type { PluginLoadOptions };
