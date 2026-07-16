import { pluginLoaderCacheInstances, type CachedPluginState } from "./loader-cache-instances.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions, PluginRuntimeSubagentMode } from "./loader-types.js";

export const pluginLoaderCacheState = pluginLoaderCacheInstances.scoped;
const fullWorkspacePluginLoaderCacheState = pluginLoaderCacheInstances.fullWorkspace;

function getPluginRegistryCache(onlyPluginIds?: string[]) {
  return onlyPluginIds ? pluginLoaderCacheState : fullWorkspacePluginLoaderCacheState;
}

function getCachedPluginRegistry(
  cacheKey: string,
  onlyPluginIds?: string[],
): CachedPluginState | undefined {
  return getPluginRegistryCache(onlyPluginIds).get(cacheKey);
}

export function setCachedPluginRegistry(
  cacheKey: string,
  state: CachedPluginState,
  onlyPluginIds?: string[],
): void {
  getPluginRegistryCache(onlyPluginIds).set(cacheKey, state);
}

export function getReusableCachedPluginRegistry(params: {
  cacheKey: string;
  onlyPluginIds: string[] | undefined;
  runtimeSubagentMode: PluginRuntimeSubagentMode;
  options: PluginLoadOptions;
}):
  | {
      state: CachedPluginState;
      cacheKey: string;
      runtimeSubagentMode: PluginRuntimeSubagentMode;
    }
  | undefined {
  const exact = getCachedPluginRegistry(params.cacheKey, params.onlyPluginIds);
  if (exact) {
    return {
      state: exact,
      cacheKey: params.cacheKey,
      runtimeSubagentMode: params.runtimeSubagentMode,
    };
  }
  if (params.runtimeSubagentMode !== "default") {
    return undefined;
  }
  const gatewayBindableContext = resolvePluginLoadCacheContext({
    ...params.options,
    runtimeOptions: {
      ...params.options.runtimeOptions,
      allowGatewaySubagentBinding: true,
    },
  });
  const gatewayBindable = getCachedPluginRegistry(
    gatewayBindableContext.cacheKey,
    gatewayBindableContext.onlyPluginIds,
  );
  if (!gatewayBindable) {
    return undefined;
  }
  return {
    state: gatewayBindable,
    cacheKey: gatewayBindableContext.cacheKey,
    runtimeSubagentMode: gatewayBindableContext.runtimeSubagentMode,
  };
}

export function clearPluginRegistryLoadCache(): void {
  pluginLoaderCacheState.clearCachedRegistries();
  fullWorkspacePluginLoaderCacheState.clearCachedRegistries();
}

export function resolvePluginRegistryLoadCacheKey(options: PluginLoadOptions = {}): string {
  return resolvePluginLoadCacheContext(options).cacheKey;
}

export function isPluginRegistryLoadInFlight(options: PluginLoadOptions = {}): boolean {
  return pluginLoaderCacheState.isLoadInFlight(resolvePluginRegistryLoadCacheKey(options));
}
