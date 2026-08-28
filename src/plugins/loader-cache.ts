import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PluginLoaderCacheState } from "./loader-cache-state.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { clearPluginRuntimeArtifactResolutionMemo } from "./plugin-runtime-artifact-resolution.js";
import type { PluginRegistry } from "./registry-types.js";

const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 128;

export const pluginLoaderCacheState = resolveGlobalSingleton(
  Symbol.for("openclaw.plugins.loader-cache-state"),
  () => new PluginLoaderCacheState<PluginRegistry>(MAX_PLUGIN_REGISTRY_CACHE_ENTRIES),
  // Runtime retirement closes registrations even when the load options stay unchanged.
  (cache) => cache.clearCachedRegistries(),
  "plugin-registry",
);

export function setCachedPluginRegistry(cacheKey: string, registry: PluginRegistry): void {
  pluginLoaderCacheState.set(cacheKey, registry);
}

export function getReusableCachedPluginRegistry(cacheKey: string): PluginRegistry | undefined {
  return pluginLoaderCacheState.get(cacheKey);
}

/** Registry reuse is off for explicit opt-outs and for raw env-substituted config loads. */
export function isPluginRegistryCacheEnabled(options: PluginLoadOptions): boolean {
  return options.cache !== false && options.resolveRawConfigEnvVars !== true;
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
