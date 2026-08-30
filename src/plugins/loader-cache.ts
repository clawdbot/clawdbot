import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { pluginLoaderCacheState } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRegistryState } from "./runtime-state.js";

/** Registry reuse is off for explicit opt-outs and for raw env-substituted config loads. */
export function isPluginRegistryCacheEnabled(options: PluginLoadOptions): boolean {
  return options.cache !== false && options.resolveRawConfigEnvVars !== true;
}

export function clearPluginRegistryLoadCache(): void {
  // Only the active registry may rebind artifacts; other retained registries stay pinned.
  getPluginRegistryState()?.activeRegistry?.pluginRuntimeArtifacts.clear();
  pluginLoaderCacheState.clearCachedRegistries();
}

export function resolvePluginRegistryLoadCacheKey(options: PluginLoadOptions = {}): string {
  return resolvePluginLoadCacheContext(options).cacheKey;
}

export function isPluginRegistryLoadInFlight(options: PluginLoadOptions = {}): boolean {
  return pluginLoaderCacheState.isLoadInFlight(resolvePluginRegistryLoadCacheKey(options));
}

/** Returns the exact active registry without activating plugins on a cache miss. */
export function resolveCompatibleRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  const state = getPluginRegistryState();
  const activeRegistry = state?.activeRegistry ?? undefined;
  if (!activeRegistry || options === undefined) {
    return activeRegistry;
  }
  const activeCacheKey = state?.key;
  if (!activeCacheKey) {
    return undefined;
  }
  return resolvePluginLoadCacheContext(options).cacheKey === activeCacheKey
    ? activeRegistry
    : undefined;
}
