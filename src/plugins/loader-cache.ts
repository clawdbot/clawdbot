import { PluginLoaderCacheState } from "./loader-cache-state.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { clearPluginRuntimeArtifactResolutionMemo } from "./plugin-runtime-artifact-resolution.js";
import type { PluginRegistry } from "./registry-types.js";

const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 128;

export const pluginLoaderCacheState = new PluginLoaderCacheState<PluginRegistry>(
  MAX_PLUGIN_REGISTRY_CACHE_ENTRIES,
);

export function setCachedPluginRegistry(cacheKey: string, registry: PluginRegistry): void {
  pluginLoaderCacheState.set(cacheKey, registry);
}

export function getReusableCachedPluginRegistry(cacheKey: string): PluginRegistry | undefined {
  return pluginLoaderCacheState.get(cacheKey);
}

export function clearPluginRegistryLoadCache(): void {
  clearPluginRuntimeArtifactResolutionMemo();
  pluginLoaderCacheState.clearCachedRegistries();
}

export function resolvePluginRegistryLoadCacheKey(options: PluginLoadOptions = {}): string {
  return resolvePluginLoadCacheContext(options).cacheKey;
}

export function isPluginRegistryLoadInFlight(options: PluginLoadOptions = {}): boolean {
  return pluginLoaderCacheState.isLoadInFlight(resolvePluginRegistryLoadCacheKey(options));
}
