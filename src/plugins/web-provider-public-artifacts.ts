// Extracts web provider public artifacts from plugin entrypoints.
import path from "node:path";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { readBundledDiscoveryMode } from "./bundled-discovery-state.js";
import { resolveEnabledBundledManifestContractPlugins } from "./bundled-manifest-contract-plugins.js";
import { normalizePluginId } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginWebFetchProviderEntry, PluginWebSearchProviderEntry } from "./types.js";
import { resolveBundledWebFetchResolutionConfig } from "./web-fetch-providers.shared.js";
import {
  loadBundledWebFetchProviderEntriesFromDir,
  loadBundledWebSearchProviderEntriesFromDir,
  resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.explicit.js";
import { resolveManifestDeclaredWebProviderCandidates } from "./web-provider-resolution-shared.js";
import { resolveBundledWebSearchResolutionConfig } from "./web-search-providers.shared.js";

type BundledWebProviderPublicArtifactParams = {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
};

function filterAllowlistedBundledPluginIds(
  config: PluginLoadOptions["config"] | undefined,
  pluginIds: readonly string[],
) {
  // Deprecated shipped compat marker: old allowlist configs used this to keep
  // bundled web provider discovery available while plugin IDs were tightened.
  if (readBundledDiscoveryMode() === "compat") {
    return [...pluginIds];
  }
  const allow = config?.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return [...pluginIds];
  }
  const allowedPluginIds = new Set(
    normalizeUniqueStringEntries(allow.map((pluginId) => normalizePluginId(pluginId))),
  );
  return pluginIds.filter((pluginId) => allowedPluginIds.has(pluginId));
}

function resolveBundledCandidatePluginIds(params: {
  contract: "webSearchProviders" | "webFetchProviders";
  configKey: "webSearch" | "webFetch";
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
}) {
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

function resolveBundledRuntimeCandidatePluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds: readonly string[];
}): string[] | null {
  const resolvedConfig = resolveBundledWebFetchResolutionConfig(params).config;
  const candidates = resolveManifestDeclaredWebProviderCandidates({
    contract: "webFetchProviders",
    configKey: "webFetch",
    config: resolvedConfig,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
  });
  const pluginIds = filterAllowlistedBundledPluginIds(resolvedConfig, candidates.pluginIds ?? []);
  const recordsByPluginId = new Map(
    (candidates.manifestRecords ?? [])
      .filter((record) => pluginIds.includes(record.id))
      .map((record) => [record.id, record] as const),
  );
  if (pluginIds.some((pluginId) => recordsByPluginId.get(pluginId)?.origin !== "bundled")) {
    return null;
  }
  const enabledPluginIds = new Set(
    resolveEnabledBundledManifestContractPlugins({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      onlyPluginIds: pluginIds,
      contract: "webFetchProviders",
    }).map((plugin) => plugin.id),
  );
  return pluginIds.filter((pluginId) => enabledPluginIds.has(pluginId));
}

function resolveBundledWebProvidersFromPublicArtifacts<TProvider>(params: {
  loadExplicit: (params: { onlyPluginIds: readonly string[] }) => TProvider[] | null;
  loadFromDir: (params: { dirName: string; pluginId: string }) => TProvider[] | null;
  contract: "webSearchProviders" | "webFetchProviders";
  configKey: "webSearch" | "webFetch";
  resolution: BundledWebProviderPublicArtifactParams;
}): TProvider[] | null {
  const candidates = resolveBundledCandidatePluginIds({
    contract: params.contract,
    configKey: params.configKey,
    config: params.resolution.config,
    workspaceDir: params.resolution.workspaceDir,
    env: params.resolution.env,
    onlyPluginIds: params.resolution.onlyPluginIds,
  });
  if (candidates.pluginIds.length === 0) {
    return [];
  }
  // Explicit scopes stay on named artifacts; unscoped discovery already carries
  // manifest records into this fast-path attempt.
  const explicitProviders = params.loadExplicit({ onlyPluginIds: candidates.pluginIds });
  if (explicitProviders) {
    return explicitProviders;
  }
  const allowedPluginIds = new Set(candidates.pluginIds);
  const recordsByPluginId = new Map(
    (
      candidates.manifestRecords ??
      loadManifestMetadataSnapshot({
        config: params.resolution.config,
        workspaceDir: params.resolution.workspaceDir,
        env: params.resolution.env,
      }).plugins
    )
      .filter((record) => record.origin === "bundled" && allowedPluginIds.has(record.id))
      .map((record) => [record.id, record] as const),
  );
  const providers: TProvider[] = [];
  // Candidate coverage is authoritative: a missing artifact invalidates the
  // complete resolution instead of returning a partial provider set.
  for (const pluginId of candidates.pluginIds) {
    const record = recordsByPluginId.get(pluginId);
    if (!record) {
      return null;
    }
    const loadedProviders = params.loadFromDir({
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

export function resolveBundledWebSearchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebSearchProviderEntry[] | null {
  return resolveBundledWebProvidersFromPublicArtifacts({
    contract: "webSearchProviders",
    configKey: "webSearch",
    resolution: params,
    loadExplicit: resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    loadFromDir: loadBundledWebSearchProviderEntriesFromDir,
  });
}

export function resolveBundledWebFetchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams,
): PluginWebFetchProviderEntry[] | null {
  return resolveBundledWebProvidersFromPublicArtifacts({
    contract: "webFetchProviders",
    configKey: "webFetch",
    resolution: params,
    loadExplicit: resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
    loadFromDir: loadBundledWebFetchProviderEntriesFromDir,
  });
}

export function resolveBundledRuntimeWebFetchProvidersFromPublicArtifacts(
  params: BundledWebProviderPublicArtifactParams & {
    onlyPluginIds: readonly string[];
  },
): PluginWebFetchProviderEntry[] | null {
  const pluginIds = resolveBundledRuntimeCandidatePluginIds({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
  });
  if (!pluginIds) {
    return null;
  }
  if (pluginIds.length === 0) {
    return [];
  }
  return resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts({
    onlyPluginIds: pluginIds,
  });
}
