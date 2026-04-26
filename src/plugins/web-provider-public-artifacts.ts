import path from "node:path";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import type { PluginWebFetchProviderEntry, PluginWebSearchProviderEntry } from "./types.js";
import { resolveBundledWebFetchResolutionConfig } from "./web-fetch-providers.shared.js";
import {
  loadBundledWebFetchProviderEntriesFromDir,
  loadBundledWebSearchProviderEntriesFromDir,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.explicit.js";
import { resolveManifestDeclaredWebProviderCandidatePluginIds } from "./web-provider-resolution-shared.js";
import { resolveBundledWebSearchResolutionConfig } from "./web-search-providers.shared.js";

type BundledWebProviderPublicArtifactParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
};

function resolveBundledCandidatePluginIds(params: {
  contract: "webSearchProviders" | "webFetchProviders";
  configKey: "webSearch" | "webFetch";
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
}): string[] {
  if (params.onlyPluginIds && params.onlyPluginIds.length > 0) {
    return [...new Set(params.onlyPluginIds)].toSorted((left, right) => left.localeCompare(right));
  }
  const resolvedConfig =
    params.contract === "webSearchProviders"
      ? resolveBundledWebSearchResolutionConfig(params).config
      : resolveBundledWebFetchResolutionConfig(params).config;
  return (
    resolveManifestDeclaredWebProviderCandidatePluginIds({
      contract: params.contract,
      configKey: params.configKey,
      config: resolvedConfig,
      workspaceDir: params.workspaceDir,
      env: params.env,
      onlyPluginIds: params.onlyPluginIds,
      origin: "bundled",
    }) ?? []
  );
}

function resolveBundledManifestRecordsByPluginId(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds: readonly string[];
}) {
  const allowedPluginIds = new Set(params.onlyPluginIds);
  return new Map(
    loadPluginManifestRegistryForPluginRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      includeDisabled: true,
    })
      .plugins.filter((record) => record.origin === "bundled" && allowedPluginIds.has(record.id))
      .map((record) => [record.id, record] as const),
  );
}

export function resolveBundledWebSearchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebSearchProviderEntry[] | null {
  const pluginIds = resolveBundledCandidatePluginIds({
    contract: "webSearchProviders",
    configKey: "webSearch",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
  });
  if (pluginIds.length === 0) {
    return [];
  }
  const directProviders = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
    onlyPluginIds: pluginIds,
  });
  if (directProviders) {
    return directProviders;
  }
  const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: pluginIds,
  });
  const providers: PluginWebSearchProviderEntry[] = [];
  for (const pluginId of pluginIds) {
    const record = recordsByPluginId.get(pluginId);
    if (!record) {
      return null;
    }
    const loadedProviders = loadBundledWebSearchProviderEntriesFromDir({
      dirName: path.basename(record.rootDir),
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}

export function resolveBundledWebFetchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebFetchProviderEntry[] | null {
  const pluginIds = resolveBundledCandidatePluginIds({
    contract: "webFetchProviders",
    configKey: "webFetch",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    onlyPluginIds: params.onlyPluginIds,
  });
  if (pluginIds.length === 0) {
    return [];
  }
  const directProviders = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({
    onlyPluginIds: pluginIds,
  });
  if (directProviders) {
    return directProviders;
  }
  const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: pluginIds,
  });
  const providers: PluginWebFetchProviderEntry[] = [];
  for (const pluginId of pluginIds) {
    const record = recordsByPluginId.get(pluginId);
    if (!record) {
      return null;
    }
    const loadedProviders = loadBundledWebFetchProviderEntriesFromDir({
      dirName: path.basename(record.rootDir),
      pluginId,
    });
    if (!loadedProviders) {
      return null;
    }
    providers.push(...loadedProviders);
  }
  return providers;
}
