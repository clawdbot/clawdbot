// Public provider-catalog runtime seams for provider plugin contract tests.

import { acquirePluginProvidersCore } from "../plugins/providers.runtime.js";
import {
  PluginRegistryResourceScope,
  createPluginRegistryResourceLease,
} from "../plugins/registry-resources.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";

export { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.js";
export {
  resolveCatalogHookProviderPluginIds,
  resolveOwningPluginIdsForProvider,
} from "../plugins/providers.js";
export { isPluginProvidersLoadInFlight } from "../plugins/providers.runtime.js";
type PluginProvidersHandle = ReturnType<typeof createPluginRegistryResourceLease> & {
  providers: ProviderPlugin[];
};

/** Acquire provider callbacks for an explicit operation or host lifetime. */
export function acquirePluginProviders(
  params: Parameters<typeof acquirePluginProvidersCore>[0],
): PluginProvidersHandle {
  const resources = new PluginRegistryResourceScope();
  try {
    const handle = resources.run(() => acquirePluginProvidersCore(params));
    if (handle.registry) {
      resources.adopt({ registry: handle.registry, release: handle.release });
    } else {
      handle.release();
    }
    return { providers: handle.providers, ...createPluginRegistryResourceLease(resources) };
  } catch (error) {
    resources.release();
    throw error;
  }
}

/**
 * @deprecated Use acquirePluginProviders and release after all returned callbacks finish.
 * Legacy callers retain providers until host close/restart, or process exit in standalone use.
 */
export function resolvePluginProviders(
  params: Parameters<typeof acquirePluginProvidersCore>[0],
): PluginProvidersHandle["providers"] {
  return withLegacyPluginSdkResourceScope((resources) => {
    const handle = acquirePluginProvidersCore(params);
    try {
      if (handle.registry) {
        resources.retain(handle.registry);
      }
      return handle.providers;
    } finally {
      handle.release();
    }
  });
}
