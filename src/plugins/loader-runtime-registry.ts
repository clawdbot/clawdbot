import { isPluginRegistryLoadInFlight } from "./loader-cache.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import { loadOpenClawPlugins } from "./loader-runtime-load.js";
import type { PluginLoadOptions } from "./loader-types.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistry, getActivePluginRegistryKey } from "./runtime.js";

function getExactActivePluginRegistry(options?: PluginLoadOptions): PluginRegistry | undefined {
  const activeRegistry = getActivePluginRegistry() ?? undefined;
  if (!activeRegistry || options === undefined) {
    return activeRegistry;
  }
  const activeCacheKey = getActivePluginRegistryKey();
  if (!activeCacheKey) {
    return undefined;
  }
  return resolvePluginLoadCacheContext(options).cacheKey === activeCacheKey
    ? activeRegistry
    : undefined;
}

export function resolveRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  const activeRegistry = getExactActivePluginRegistry(options);
  if (activeRegistry) {
    return activeRegistry;
  }
  // Runtime helpers must not recurse while this exact snapshot is registering.
  // Direct loadOpenClawPlugins callers still surface the hard error.
  if (isPluginRegistryLoadInFlight(options)) {
    return undefined;
  }
  // Runtime consumers own handles. Process-root installation is reserved for
  // loadAndActivateRootPluginRegistry at the composition boundary.
  return loadOpenClawPlugins({ ...options, activate: false });
}

export function getRuntimePluginRegistryForLoadOptions(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  return resolveRuntimePluginRegistry(options);
}

/** Return the exact active registry without triggering a fresh load on cache miss. */
export function resolveCompatibleRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  return getExactActivePluginRegistry(options);
}
