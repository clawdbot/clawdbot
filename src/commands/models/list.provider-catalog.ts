/** Provider plugin catalog loading for model-list output. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles/store.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "../../agents/models-config.providers.secrets.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { Model } from "../../llm/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  loadPluginRegistrySnapshotWithMetadata,
  resolvePluginContributionOwners,
  resolveProviderOwners,
  type PluginRegistrySnapshot,
} from "../../plugins/plugin-registry.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog,
  runProviderStaticCatalog,
} from "../../plugins/provider-discovery.js";
import {
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef,
} from "../../plugins/providers.js";
import type { ProviderPlugin } from "../../plugins/types.js";

const DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;
const SELF_HOSTED_DISCOVERY_PROVIDER_IDS = new Set(["lmstudio", "ollama", "sglang", "vllm"]);
const log = createSubsystemLogger("models/list-provider-catalog");

function providerMatchesFilter(params: {
  provider: Pick<ProviderPlugin, "id" | "aliases" | "hookAliases">;
  providerFilter: string;
}): boolean {
  return [
    params.provider.id,
    ...(params.provider.aliases ?? []),
    ...(params.provider.hookAliases ?? []),
  ].some((providerId) => normalizeProviderId(providerId) === params.providerFilter);
}

function collectMatchingContributionOwners(
  index: PluginRegistrySnapshot,
  contribution: "providers" | "cliBackends",
  providerFilter: string,
  cfg: OpenClawConfig,
  options: { includeDisabled?: boolean } = {},
): string[] {
  if (contribution === "providers") {
    return [
      ...resolveProviderOwners({
        index,
        providerId: providerFilter,
        includeDisabled: options.includeDisabled,
        config: cfg,
      }),
    ];
  }
  return [
    ...resolvePluginContributionOwners({
      index,
      contribution: "cliBackends",
      matches: (contributionId) => normalizeProviderId(contributionId) === providerFilter,
      includeDisabled: options.includeDisabled,
      config: cfg,
    }),
  ];
}

function resolveInstalledIndexPluginIdsForProviderFilter(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  providerFilter: string;
  registryIndex?: PluginRegistrySnapshot;
}): string[] | undefined {
  const snapshot = loadPluginRegistrySnapshotWithMetadata({
    config: params.cfg,
    env: params.env,
    index: params.registryIndex,
  });
  if (snapshot.source !== "persisted" && snapshot.source !== "provided") {
    return undefined;
  }
  const index = snapshot.snapshot;
  const pluginIds = [
    ...collectMatchingContributionOwners(index, "providers", params.providerFilter, params.cfg),
    ...collectMatchingContributionOwners(index, "cliBackends", params.providerFilter, params.cfg),
  ];
  if (pluginIds.length > 0) {
    return sortUniqueStrings(pluginIds);
  }
  const disabledPluginIds = [
    ...collectMatchingContributionOwners(index, "providers", params.providerFilter, params.cfg, {
      includeDisabled: true,
    }),
    ...collectMatchingContributionOwners(index, "cliBackends", params.providerFilter, params.cfg, {
      includeDisabled: true,
    }),
  ];
  return disabledPluginIds.length > 0 ? [] : undefined;
}

/** Resolves plugin ids that can provide catalog rows for a provider filter. */
export async function resolveProviderCatalogPluginIdsForFilter(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  providerFilter: string;
  registryIndex?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<string[] | undefined> {
  const providerFilter = normalizeProviderId(params.providerFilter);
  if (!providerFilter) {
    return undefined;
  }
  const installedIndexPluginIds = resolveInstalledIndexPluginIdsForProviderFilter({
    cfg: params.cfg,
    env: params.env,
    providerFilter,
    registryIndex: params.metadataSnapshot?.index ?? params.registryIndex,
  });
  if (installedIndexPluginIds) {
    // Installed registry metadata is process-stable and knows disabled plugins,
    // so it wins over broader manifest/contract alias fallbacks.
    return installedIndexPluginIds;
  }
  const manifestPluginIds = resolveOwningPluginIdsForProviderRef({
    provider: providerFilter,
    config: params.cfg,
    env: params.env,
    manifestRegistry: params.metadataSnapshot?.manifestRegistry,
  });
  if (manifestPluginIds) {
    return manifestPluginIds;
  }
  const { resolveProviderContractPluginIdsForProviderAlias } =
    await import("../../plugins/contracts/registry.js");
  const bundledAliasPluginIds = resolveProviderContractPluginIdsForProviderAlias(providerFilter);
  if (bundledAliasPluginIds) {
    return bundledAliasPluginIds;
  }
  return undefined;
}

/** Returns true when a provider filter can be satisfied by a static bundled catalog. */
export async function hasProviderStaticCatalogForFilter(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  providerFilter: string;
  registryIndex?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<boolean> {
  return await hasProviderCatalogForFilter(
    params,
    (provider) => typeof provider.staticCatalog?.run === "function",
    { discoveryEntriesOnly: true },
  );
}

export async function hasProviderRuntimeCatalogForFilter(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  providerFilter: string;
  registryIndex?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<boolean> {
  return await hasProviderCatalogForFilter(
    params,
    (provider) =>
      typeof provider.catalog?.run === "function" || typeof provider.discovery?.run === "function",
    { discoveryEntriesOnly: false },
  );
}

async function hasProviderCatalogForFilter(
  params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    providerFilter: string;
    registryIndex?: PluginRegistrySnapshot;
    metadataSnapshot?: PluginMetadataSnapshot;
  },
  predicate: (provider: ProviderPlugin) => boolean,
  options: { discoveryEntriesOnly: boolean },
): Promise<boolean> {
  const env = params.env ?? process.env;
  const providerFilter = normalizeProviderId(params.providerFilter);
  if (!providerFilter) {
    return false;
  }
  const pluginIds = await resolveProviderCatalogPluginIdsForFilter({
    ...params,
    env,
    registryIndex: params.metadataSnapshot?.index ?? params.registryIndex,
  });
  if (!pluginIds || pluginIds.length === 0) {
    return false;
  }
  const bundledPluginIds = resolveBundledProviderCompatPluginIds({
    config: params.cfg,
    env,
    manifestRegistry: params.metadataSnapshot?.manifestRegistry,
  });
  const bundledPluginIdSet = new Set(bundledPluginIds);
  const scopedPluginIds = pluginIds.filter((pluginId) => bundledPluginIdSet.has(pluginId));
  if (scopedPluginIds.length === 0) {
    return false;
  }
  const providers = await resolveRuntimePluginDiscoveryProviders({
    config: params.cfg,
    env,
    onlyPluginIds: scopedPluginIds,
    includeUntrustedWorkspacePlugins: false,
    requireCompleteDiscoveryEntryCoverage: options.discoveryEntriesOnly,
    discoveryEntriesOnly: options.discoveryEntriesOnly,
    pluginMetadataSnapshot: params.metadataSnapshot,
  });
  return providers.some(
    (provider) => predicate(provider) && providerMatchesFilter({ provider, providerFilter }),
  );
}

function modelFromProviderCatalog(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelProviderConfig["models"][number];
}): Model {
  return {
    id: params.model.id,
    name: params.model.name || params.model.id,
    provider: params.provider,
    api: params.model.api ?? params.providerConfig.api ?? "openai-responses",
    baseUrl: params.model.baseUrl ?? params.providerConfig.baseUrl,
    reasoning: params.model.reasoning,
    input: params.model.input ?? ["text"],
    cost: params.model.cost,
    contextWindow: params.model.contextWindow,
    contextTokens: params.model.contextTokens,
    maxTokens: params.model.maxTokens,
    headers: params.model.headers,
    compat: params.model.compat,
  } as Model;
}

async function runProviderCatalogForList(params: {
  provider: ProviderPlugin;
  cfg: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  staticOnly?: boolean;
}): Promise<Awaited<ReturnType<typeof runProviderCatalog>> | null> {
  if (params.staticOnly === true) {
    return (
      (await runProviderStaticCatalog({
        provider: params.provider,
        config: params.cfg,
        agentDir: params.agentDir,
        env: params.env,
      })) ?? null
    );
  }

  const hasRuntimeCatalog =
    typeof params.provider.catalog?.run === "function" ||
    typeof params.provider.discovery?.run === "function";
  if (hasRuntimeCatalog) {
    const authStore = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir);
    const resolveProviderApiKey = createProviderApiKeyResolver(params.env, authStore, params.cfg);
    const resolveProviderAuth = createProviderAuthResolver(params.env, authStore, params.cfg);
    try {
      const runtimeResult = await runProviderCatalog({
        provider: params.provider,
        config: params.cfg,
        agentDir: params.agentDir,
        env: params.env,
        resolveProviderApiKey: (providerId) =>
          resolveProviderApiKey(providerId?.trim() || params.provider.id),
        resolveProviderAuth: (providerId, options) =>
          resolveProviderAuth(providerId?.trim() || params.provider.id, options),
      });
      if (runtimeResult) {
        return runtimeResult;
      }
    } catch (error) {
      log.warn(
        `provider runtime catalog failed for ${params.provider.id}: ${formatErrorMessage(error)}`,
      );
    }
  }

  if (typeof params.provider.staticCatalog?.run !== "function") {
    return null;
  }
  return (
    (await runProviderStaticCatalog({
      provider: params.provider,
      config: params.cfg,
      agentDir: params.agentDir,
      env: params.env,
    })) ?? null
  );
}

/** Loads model rows from provider static/runtime catalog hooks for model-list output. */
export async function loadProviderCatalogModelsForList(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  providerFilter?: string;
  staticOnly?: boolean;
  registryIndex?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<Model[]> {
  const env = params.env ?? process.env;
  const providerFilter = params.providerFilter ? normalizeProviderId(params.providerFilter) : "";
  const onlyPluginIds = providerFilter
    ? await resolveProviderCatalogPluginIdsForFilter({
        cfg: params.cfg,
        env,
        providerFilter,
        registryIndex: params.metadataSnapshot?.index ?? params.registryIndex,
        metadataSnapshot: params.metadataSnapshot,
      })
    : undefined;
  if (providerFilter && !onlyPluginIds) {
    return [];
  }

  const bundledPluginIds = resolveBundledProviderCompatPluginIds({
    config: params.cfg,
    env,
    manifestRegistry: params.metadataSnapshot?.manifestRegistry,
  });
  const bundledPluginIdSet = new Set(bundledPluginIds);
  const scopedPluginIds = onlyPluginIds
    ? onlyPluginIds.filter((pluginId) => bundledPluginIdSet.has(pluginId))
    : bundledPluginIds;
  if (scopedPluginIds.length === 0) {
    return [];
  }

  const providers = (
    await resolveRuntimePluginDiscoveryProviders({
      config: params.cfg,
      env,
      onlyPluginIds: scopedPluginIds,
      includeUntrustedWorkspacePlugins: false,
      requireCompleteDiscoveryEntryCoverage: params.staticOnly === true,
      discoveryEntriesOnly: params.staticOnly === true,
      pluginMetadataSnapshot: params.metadataSnapshot,
    })
  ).filter(
    (provider) =>
      typeof provider.pluginId === "string" && bundledPluginIdSet.has(provider.pluginId),
  );
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const rows: Model[] = [];
  const seen = new Set<string>();

  for (const order of DISCOVERY_ORDERS) {
    for (const provider of byOrder[order] ?? []) {
      if (!providerFilter && SELF_HOSTED_DISCOVERY_PROVIDER_IDS.has(provider.id)) {
        continue;
      }
      let result: Awaited<ReturnType<typeof runProviderCatalog>> | null;
      try {
        result = await runProviderCatalogForList({
          provider,
          cfg: params.cfg,
          agentDir: params.agentDir,
          env,
          staticOnly: params.staticOnly,
        });
      } catch (error) {
        log.warn(`provider catalog failed for ${provider.id}: ${formatErrorMessage(error)}`);
        result = null;
      }
      const normalized = normalizePluginDiscoveryResult({ provider, result });
      for (const [providerIdRaw, providerConfig] of Object.entries(normalized)) {
        const providerId = normalizeProviderId(providerIdRaw);
        if (providerFilter && providerId !== providerFilter) {
          continue;
        }
        if (!providerId || !Array.isArray(providerConfig.models)) {
          continue;
        }
        for (const model of providerConfig.models) {
          const key = `${providerId}/${model.id}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          rows.push(
            modelFromProviderCatalog({
              provider: providerId,
              providerConfig,
              model,
            }),
          );
        }
      }
    }
  }

  return rows.toSorted((left, right) => {
    const provider = left.provider.localeCompare(right.provider);
    if (provider !== 0) {
      return provider;
    }
    return left.id.localeCompare(right.id);
  });
}
