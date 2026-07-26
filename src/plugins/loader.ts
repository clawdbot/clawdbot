/** Stable public facade for plugin loading and runtime-registry resolution. */
export {
  clearPluginRegistryLoadCache,
  isPluginRegistryLoadInFlight,
  resolvePluginRegistryLoadCacheKey,
} from "./loader-cache.js";
export { loadOpenClawPluginCliRegistry } from "./loader-cli-registry.js";
export {
  getRuntimePluginRegistryForLoadOptions,
  resolveCompatibleRuntimePluginRegistry,
  resolveRuntimePluginRegistry,
} from "./loader-runtime-registry.js";
export { clearActivatedPluginRuntimeState, loadOpenClawPlugins } from "./loader-runtime-load.js";
export type { PluginLoadOptions } from "./loader-types.js";
