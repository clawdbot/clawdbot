/** Stable public facade for plugin loading and runtime-registry resolution. */
import { loadOpenClawPlugins } from "./loader-runtime-load.js";
import type { PluginLoadOptions } from "./loader-types.js";
export { resolveCompatibleRuntimePluginRegistry } from "./active-runtime-registry.js";
export {
  clearPluginRegistryLoadCache,
  isPluginRegistryLoadInFlight,
  resolvePluginRegistryLoadCacheKey,
} from "./loader-cache.js";
export { resolveRuntimePluginRegistry } from "./loader-runtime-registry.js";

/** Loads a caller-owned registry value without changing the process-wide active registry. */
export function loadPluginRegistryHandle(options: PluginLoadOptions = {}) {
  return loadOpenClawPlugins({ ...options, activate: false });
}

/** Collects CLI descriptors through the same validation and instance owner as runtime loading. */
export async function loadOpenClawPluginCliRegistry(options: PluginLoadOptions = {}) {
  return loadOpenClawPlugins({
    ...options,
    mode: "cli-metadata",
    activate: false,
    runtimeSideEffects: false,
  });
}

/** Loads and installs the registry owned by a process composition root. */
export function loadAndActivateRootPluginRegistry(options: PluginLoadOptions = {}) {
  return loadOpenClawPlugins({ ...options, activate: true });
}

export { loadOpenClawPlugins };
export type { PluginLoadOptions };
