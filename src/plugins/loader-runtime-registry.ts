import {
  isPluginRegistryLoadInFlight,
  resolveCompatibleRuntimePluginRegistry,
} from "./loader-cache.js";
import { loadOpenClawPlugins } from "./loader-runtime-load.js";
import type { PluginLoadOptions } from "./loader-types.js";
import type { PluginRegistry } from "./registry-types.js";

export function resolveRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  const activeRegistry = resolveCompatibleRuntimePluginRegistry(options);
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
