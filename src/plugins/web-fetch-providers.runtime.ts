import { loadOpenClawPlugins } from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import { type PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebFetchProviderEntry } from "./types.js";
import {
  resolveBundledWebFetchResolutionConfig,
  sortWebFetchProviders,
} from "./web-fetch-providers.shared.js";
import { resolveBundledWebFetchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.js";
import {
  mapRegistryProviders,
  resolveManifestDeclaredWebProviderCandidatePluginIds,
} from "./web-provider-resolution-shared.js";
import {
  createWebProviderSnapshotCache,
  resolvePluginWebProviders,
  resolveRuntimeWebProviders,
} from "./web-provider-runtime-shared.js";

let webFetchProviderSnapshotCache = createWebProviderSnapshotCache<PluginWebFetchProviderEntry>();

function resetWebFetchProviderSnapshotCacheForTests() {
  webFetchProviderSnapshotCache = createWebProviderSnapshotCache<PluginWebFetchProviderEntry>();
}

export const __testing = {
  resetWebFetchProviderSnapshotCacheForTests,
} as const;

function resolveWebFetchCandidatePluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
}): string[] | undefined {
  return resolveManifestDeclaredWebProviderCandidatePluginIds({
    contract: "webFetchProviders",
    configKey: "webFetch",
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    origin: params.origin,
  });
}

function mapRegistryWebFetchProviders(params: {
  registry: ReturnType<typeof loadOpenClawPlugins>;
  onlyPluginIds?: readonly string[];
}): PluginWebFetchProviderEntry[] {
  return mapRegistryProviders({
    entries: params.registry.webFetchProviders,
    onlyPluginIds: params.onlyPluginIds,
    sortProviders: sortWebFetchProviders,
  });
}

export function resolvePluginWebFetchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
}): PluginWebFetchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    snapshotCache: webFetchProviderSnapshotCache,
    resolveBundledResolutionConfig: resolveBundledWebFetchResolutionConfig,
    resolveCandidatePluginIds: resolveWebFetchCandidatePluginIds,
    mapRegistryProviders: mapRegistryWebFetchProviders,
    resolveBundledPublicArtifactProviders: resolveBundledWebFetchProvidersFromPublicArtifacts,
  });
}

export function resolveRuntimeWebFetchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
}): PluginWebFetchProviderEntry[] {
  return resolveRuntimeWebProviders(params, {
    snapshotCache: webFetchProviderSnapshotCache,
    resolveBundledResolutionConfig: resolveBundledWebFetchResolutionConfig,
    resolveCandidatePluginIds: resolveWebFetchCandidatePluginIds,
    mapRegistryProviders: mapRegistryWebFetchProviders,
  });
}
