// Shares web-search provider loading helpers across runtime paths.
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { sortPluginEntriesById, sortPluginEntriesForAutoDetect } from "./plugin-entry-order.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
import { resolveBundledWebProviderResolutionConfig } from "./web-provider-resolution-shared.js";

export function sortWebSearchProviders(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return sortPluginEntriesById(providers);
}

export function sortWebSearchProvidersForAutoDetect(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return sortPluginEntriesForAutoDetect(providers);
}

export function resolveBundledWebSearchResolutionConfig(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRecords?: readonly PluginManifestRecord[];
}): {
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
  manifestRecords?: readonly PluginManifestRecord[];
} {
  return resolveBundledWebProviderResolutionConfig({
    contract: "webSearchProviders",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    manifestRecords: params.manifestRecords,
  });
}
