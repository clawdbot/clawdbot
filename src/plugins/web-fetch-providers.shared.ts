// Shares web fetch provider loading helpers across provider plugins.
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { sortPluginEntriesById, sortPluginEntriesForAutoDetect } from "./plugin-entry-order.js";
import type { PluginWebFetchProviderEntry } from "./types.js";
import { resolveBundledWebProviderResolutionConfig } from "./web-provider-resolution-shared.js";

export function sortWebFetchProviders(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return sortPluginEntriesById(providers);
}

export function sortWebFetchProvidersForAutoDetect(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return sortPluginEntriesForAutoDetect(providers);
}

export function resolveBundledWebFetchResolutionConfig(params: {
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
    contract: "webFetchProviders",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    manifestRecords: params.manifestRecords,
  });
}
