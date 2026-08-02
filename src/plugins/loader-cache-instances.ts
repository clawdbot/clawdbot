import { PluginLoaderCacheState } from "./loader-cache-state.js";
import type { PluginRegistry } from "./registry-types.js";

export type CachedPluginState = PluginRegistry;

const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 128;

export const pluginLoaderCacheInstances = {
  scoped: new PluginLoaderCacheState<CachedPluginState>(MAX_PLUGIN_REGISTRY_CACHE_ENTRIES),
  fullWorkspace: new PluginLoaderCacheState<CachedPluginState>(MAX_PLUGIN_REGISTRY_CACHE_ENTRIES),
};
