import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { listManifestProviderContributionIds } from "./manifest-contribution-ids.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import type { LoadPluginRegistryParams, PluginRegistrySnapshot } from "./plugin-registry.js";
import { copyProviderCatalogResultProjection } from "./provider-catalog-result.js";
import type { ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";

const DISCOVERY_ORDER: readonly ProviderDiscoveryOrder[] = ["simple", "profile", "paired", "late"];
const DANGEROUS_PROVIDER_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const providerRuntimeLoader = createLazyImportLoader(
  () => import("./provider-discovery.runtime.js"),
);

function loadProviderRuntime() {
  return providerRuntimeLoader.load();
}

function resolveProviderCatalogHook(provider: ProviderPlugin) {
  return provider.catalog ?? provider.discovery;
}

function resolveProviderCatalogOrderHook(provider: ProviderPlugin) {
  return resolveProviderCatalogHook(provider) ?? provider.staticCatalog;
}

function createProviderConfigRecord(): Record<string, ModelProviderConfig> {
  return Object.create(null) as Record<string, ModelProviderConfig>;
}

function isSafeProviderConfigKey(value: string): boolean {
  return value !== "" && !DANGEROUS_PROVIDER_KEYS.has(value);
}

export type ResolveRuntimePluginDiscoveryProvidersParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
};

export type ResolveInstalledPluginProviderContributionIdsParams = LoadPluginRegistryParams & {
  index?: PluginRegistrySnapshot;
  includeDisabled?: boolean;
};

export function resolveInstalledPluginProviderContributionIds(
  params: ResolveInstalledPluginProviderContributionIdsParams = {},
): string[] {
  const registryParams =
    params.candidates && params.preferPersisted === undefined
      ? { ...params, preferPersisted: false }
      : params;
  return sortUniqueStrings(
    listManifestProviderContributionIds({
      ...registryParams,
      index: params.index,
      includeDisabled: params.includeDisabled,
    }),
  );
}

export async function resolveRuntimePluginDiscoveryProviders(
  params: ResolveRuntimePluginDiscoveryProvidersParams,
): Promise<ProviderPlugin[]> {
  return (await loadProviderRuntime())
    .resolvePluginDiscoveryProvidersRuntime(params)
    .filter((provider) => resolveProviderCatalogOrderHook(provider));
}

export function groupPluginDiscoveryProvidersByOrder(
  providers: ProviderPlugin[],
): Record<ProviderDiscoveryOrder, ProviderPlugin[]> {
  const grouped = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  } as Record<ProviderDiscoveryOrder, ProviderPlugin[]>;

  for (const provider of providers) {
    const order = resolveProviderCatalogOrderHook(provider)?.order ?? "late";
    grouped[order].push(provider);
  }

  for (const order of DISCOVERY_ORDER) {
    grouped[order].sort((a, b) => a.label.localeCompare(b.label));
  }

  return grouped;
}

export function normalizePluginDiscoveryResult(params: {
  provider: ProviderPlugin;
  result:
    | { provider: ModelProviderConfig }
    | { providers: Record<string, ModelProviderConfig> }
    | null
    | undefined;
}): Record<string, ModelProviderConfig> {
  const result = params.result;
  if (!result) {
    return {};
  }

  const projection = copyProviderCatalogResultProjection(result);
  if (projection.kind === "provider") {
    const normalized = createProviderConfigRecord();
    for (const providerId of [
      params.provider.id,
      ...(params.provider.aliases ?? []),
      ...(params.provider.hookAliases ?? []),
    ]) {
      const normalizedKey = normalizeProviderId(providerId);
      if (!isSafeProviderConfigKey(normalizedKey)) {
        continue;
      }
      normalized[normalizedKey] = projection.provider;
    }
    return normalized;
  }

  const normalized = createProviderConfigRecord();
  if (projection.kind !== "providers") {
    return normalized;
  }
  for (const [key, value] of projection.providers) {
    const normalizedKey = normalizeProviderId(key);
    if (!isSafeProviderConfigKey(normalizedKey) || !value) {
      continue;
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

export function runProviderCatalog(params: {
  provider: ProviderPlugin;
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId?: string) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
  };
  resolveProviderAuth: (
    providerId?: string,
    options?: { oauthMarker?: string },
  ) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "aws-sdk" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
    profileId?: string;
  };
}) {
  return resolveProviderCatalogHook(params.provider)?.run({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
    resolveProviderApiKey: params.resolveProviderApiKey,
    resolveProviderAuth: params.resolveProviderAuth,
  });
}

export function runProviderStaticCatalog(params: {
  provider: ProviderPlugin;
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}) {
  return params.provider.staticCatalog?.run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({
      apiKey: undefined,
    }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      mode: "none",
      source: "none",
    }),
  });
}
