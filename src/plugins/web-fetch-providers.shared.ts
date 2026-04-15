import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebFetchProviderEntry } from "./types.js";
import {
  resolveBundledWebProviderResolutionConfig,
  sortPluginProviders,
  sortPluginProvidersForAutoDetect,
} from "./web-provider-resolution-shared.js";

export function sortWebFetchProviders(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return sortPluginProviders(providers);
}

export function sortWebFetchProvidersForAutoDetect(
  providers: PluginWebFetchProviderEntry[],
): PluginWebFetchProviderEntry[] {
  return sortPluginProvidersForAutoDetect(providers);
}

export function resolveBundledWebFetchResolutionConfig(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): {
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
} {
  return resolveBundledWebProviderResolutionConfig({
    contract: "webFetchProviders",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
  });
}
