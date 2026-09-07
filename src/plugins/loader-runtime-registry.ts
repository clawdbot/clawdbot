import { resolveCompatibleRuntimePluginRegistry } from "./active-runtime-registry.js";
import { isPluginRegistryLoadInFlight } from "./loader-cache.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { retainPluginRegistryResources, type PluginRegistryHandle } from "./registry-resources.js";

export function createPluginRuntimeRegistryResolver(
  loadRegistry: (options: PluginLoadOptions) => PluginRegistryHandle,
) {
  function resolveRuntimePluginRegistry(
    options?: PluginLoadOptions,
  ): PluginRegistryHandle | undefined {
    const activeRegistry = resolveCompatibleRuntimePluginRegistry(options);
    if (activeRegistry) {
      return { registry: activeRegistry, ...retainPluginRegistryResources(activeRegistry) };
    }
    // Runtime helpers must not recurse while this exact snapshot is registering.
    if (isPluginRegistryLoadInFlight(options)) {
      return undefined;
    }
    return loadRegistry({ ...options, activate: false });
  }
  return resolveRuntimePluginRegistry;
}
