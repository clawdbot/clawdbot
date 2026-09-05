import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { clearPluginRuntimeArtifactResolutionMemo } from "./plugin-runtime-artifact-resolution.js";
import { pluginLoaderCacheState } from "./registry-lifecycle.js";

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
