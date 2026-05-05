import path from "node:path";
import { normalizePluginId } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebFetchProviderEntry, PluginWebSearchProviderEntry } from "./types.js";
import { resolveBundledWebFetchResolutionConfig } from "./web-fetch-providers.shared.js";
import {
  loadBundledWebFetchProviderEntriesFromDir,
  loadBundledWebSearchProviderEntriesFromDir,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.explicit.js";
import { resolveManifestDeclaredWebProviderCandidates } from "./web-provider-resolution-shared.js";
import { resolveBundledWebSearchResolutionConfig } from "./web-search-providers.shared.js";

type BundledWebProviderPublicArtifactParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
};

type BundledCandidateResolution = {
  pluginIds: string[];
  manifestRecords?: readonly PluginManifestRecord[];
};

function filterAllowlistedBundledPluginIds(
  config: PluginLoadOptions["config"] | undefined,
  pluginIds: readonly string[],
) {
  const allow = config?.plugins?.allow;
  if (
    config?.plugins?.bundledDiscovery === "compat" ||
    !Array.isArray(allow) ||
    allow.length === 0
  ) {
    return [...pluginIds];
  }
  const allowedPluginIds = new Set(
    allow.map((pluginId) => normalizePluginId(pluginId)).filter(Boolean),
  );
  return pluginIds.filter((pluginId) => allowedPluginIds.has(pluginId));
}

function resolveBundledCandidatePluginIds(params: {
  contract: "webSearchProviders" | "webFetchProviders";
  configKey: "webSearch" | "webFetch";
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
}): BundledCandidateResolution {
  if (params.onlyPluginIds !== undefined) {
    return {
      pluginIds: filterAllowlistedBundledPluginIds(params.config, [
        ...new Set(params.onlyPluginIds),
      ]).toSorted((left, right) => left.localeCompare(right)),
    };
  }
  const resolvedConfig =
    params.contract === "webSearchProviders"
      ? resolveBundledWebSearchResolutionConfig(params).config
      : resolveBundledWebFetchResolutionConfig(params).config;
  const candidates = resolveManifestDeclaredWebProviderCandidates({
    contract: params.contract,
    configKey: params.configKey,
    config: resolvedConfig,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    origin: "bundled",
  });
  return {
    pluginIds: filterAllowlistedBundledPluginIds(resolvedConfig, candidates.pluginIds ?? []),
    ...(candidates.manifestRecords ? { manifestRecords: candidates.manifestRecords } : {}),
  };
}

function resolveBundledManifestRecordsByPluginId(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds: readonly string[];
  manifestRecords?: readonly PluginManifestRecord[];
}) {
  const allowedPluginIds = new Set(params.onlyPluginIds);
  const manifestRecords =
    params.manifestRecords ??
    loadManifestMetadataSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).plugins;
  return new Map(
    manifestRecords
      .filter((record) => record.origin === "bundled" && allowedPluginIds.has(record.id))
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
  if (pluginIds.pluginIds.length === 0) {
    return [];
  }
  const directProviders = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
    onlyPluginIds: pluginIds.pluginIds,
  });
  if (directProviders) {
    return directProviders;
  }
  const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: pluginIds.pluginIds,
    manifestRecords: pluginIds.manifestRecords,
  });
  const providers: PluginWebSearchProviderEntry[] = [];
  for (const pluginId of pluginIds.pluginIds) {
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
  if (pluginIds.pluginIds.length === 0) {
    return [];
  }
  const directProviders = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({
    onlyPluginIds: pluginIds.pluginIds,
  });
  if (directProviders) {
    return directProviders;
  }
  const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: pluginIds.pluginIds,
    manifestRecords: pluginIds.manifestRecords,
  });
  const providers: PluginWebFetchProviderEntry[] = [];
  for (const pluginId of pluginIds.pluginIds) {
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
