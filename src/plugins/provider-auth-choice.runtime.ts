// Runtime boundary for resolving provider auth choices from plugins.
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { loadInstalledPluginIndexWithDiscovery } from "./installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  resolveProviderPluginChoiceCore as resolveProviderPluginChoiceImpl,
  runProviderModelSelectedHookCore as runProviderModelSelectedHookImpl,
} from "./provider-wizard.js";
import { acquirePluginProvidersCore as acquirePluginProvidersImpl } from "./providers.runtime.js";
import { resolvePluginSetupProviderCore as resolvePluginSetupProviderImpl } from "./setup-registry.js";

type ResolveProviderPluginChoice =
  typeof import("./provider-wizard.js").resolveProviderPluginChoiceCore;
type RunProviderModelSelectedHook =
  typeof import("./provider-wizard.js").runProviderModelSelectedHookCore;
type AcquirePluginProviders = typeof import("./providers.runtime.js").acquirePluginProvidersCore;
type ResolvePluginSetupProvider =
  typeof import("./setup-registry.js").resolvePluginSetupProviderCore;

/** Runtime wrapper for provider plugin wizard choice resolution. */
export function resolveProviderPluginChoice(
  ...args: Parameters<ResolveProviderPluginChoice>
): ReturnType<ResolveProviderPluginChoice> {
  return resolveProviderPluginChoiceImpl(...args);
}

/** Runtime wrapper for provider model-selected hook dispatch. */
export function runProviderModelSelectedHook(
  ...args: Parameters<RunProviderModelSelectedHook>
): ReturnType<RunProviderModelSelectedHook> {
  return runProviderModelSelectedHookImpl(...args);
}

/** Runtime wrapper for registered model provider discovery. */
export function acquireProviderAuthChoiceProviders(
  params: Parameters<AcquirePluginProviders>[0],
  preparedInstallRecords?: Record<string, PluginInstallRecord>,
): ReturnType<AcquirePluginProviders> {
  if (!preparedInstallRecords) {
    return acquirePluginProvidersImpl(params);
  }
  // Installation changes package facts within the lease. Build a separate view
  // with the installer's accepted records without replacing Gateway inventory.
  return withPluginCache(createPluginCache(), () => {
    const pluginMetadataSnapshot = loadInstalledPluginIndexWithDiscovery({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      installRecords: {
        ...loadInstalledPluginIndexInstallRecordsSync({ env: params.env }),
        ...preparedInstallRecords,
      },
    });
    return acquirePluginProvidersImpl({ ...params, pluginMetadataSnapshot });
  });
}

/** Runtime wrapper for plugin setup-provider discovery. */
export function resolvePluginSetupProvider(
  ...args: Parameters<ResolvePluginSetupProvider>
): ReturnType<ResolvePluginSetupProvider> {
  return resolvePluginSetupProviderImpl(...args);
}
