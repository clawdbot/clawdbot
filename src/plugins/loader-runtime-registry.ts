import { resolveCompatibleRuntimePluginRegistry } from "./active-runtime-registry.js";
import { isPluginRegistryLoadInFlight } from "./loader-cache.js";
import type { PluginLoadOptions } from "./loader-types.js";
import type { PluginRegistry } from "./registry-types.js";

export function createPluginRuntimeRegistryResolver(
  loadRegistry: (options: PluginLoadOptions) => PluginRegistry,
) {
  function resolveRuntimePluginRegistry(options?: PluginLoadOptions): PluginRegistry | undefined {
    const activeRegistry = resolveCompatibleRuntimePluginRegistry(options);
    if (activeRegistry) {
      return activeRegistry;
    }
    // Runtime helpers must not recurse while this exact snapshot is registering.
    if (isPluginRegistryLoadInFlight(options)) {
      return undefined;
    }
    return loadRegistry({ ...options, activate: false });
  }
  return resolveRuntimePluginRegistry;
}
