import type { Api, Model } from "@mariozechner/pi-ai";
import { normalizeProviderId } from "../../agents/provider-id.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolvePluginDiscoveryProviders,
  runProviderStaticCatalog,
} from "../../plugins/provider-discovery.js";
import {
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProvider,
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

export async function resolveProviderCatalogPluginIdsForFilter(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  providerFilter: string;
}): Promise<string[] | undefined> {
  const providerFilter = normalizeProviderId(params.providerFilter);
  if (!providerFilter) {
    return undefined;
  }
  const manifestPluginIds = resolveOwningPluginIdsForProvider({
    provider: providerFilter,
    config: params.cfg,
    env: params.env,
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

export async function hasProviderStaticCatalogForFilter(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  providerFilter: string;
}): Promise<boolean> {
  const env = params.env ?? process.env;
  const providerFilter = normalizeProviderId(params.providerFilter);
  if (!providerFilter) {
    return false;
  }
  const pluginIds = await resolveProviderCatalogPluginIdsForFilter({
    ...params,
    env,
  });
  if (!pluginIds || pluginIds.length === 0) {
    return false;
  }
  const bundledPluginIds = resolveBundledProviderCompatPluginIds({
    config: params.cfg,
    env,
  });
  const bundledPluginIdSet = new Set(bundledPluginIds);
  const scopedPluginIds = pluginIds.filter((pluginId) => bundledPluginIdSet.has(pluginId));
  if (scopedPluginIds.length === 0) {
    return false;
  }
  const providers = await resolvePluginDiscoveryProviders({
    config: params.cfg,
    env,
    onlyPluginIds: scopedPluginIds,
    includeUntrustedWorkspacePlugins: false,
    requireCompleteDiscoveryEntryCoverage: true,
    discoveryEntriesOnly: true,
  });
  return providers.some(
    (provider) =>
      typeof provider.staticCatalog?.run === "function" &&
      providerMatchesFilter({ provider, providerFilter }),
  );
}

function modelFromProviderCatalog(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelProviderConfig["models"][number];
}): Model<Api> {
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
  } as Model<Api>;
}

export async function loadProviderCatalogModelsForList(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  providerFilter?: string;
  staticOnly?: boolean;
}): Promise<Model<Api>[]> {
  const env = params.env ?? process.env;
  const providerFilter = params.providerFilter ? normalizeProviderId(params.providerFilter) : "";
  const onlyPluginIds = providerFilter
    ? await resolveProviderCatalogPluginIdsForFilter({
        cfg: params.cfg,
        env,
        providerFilter,
      })
    : undefined;
  if (providerFilter && !onlyPluginIds) {
    return [];
  }

  const bundledPluginIds = resolveBundledProviderCompatPluginIds({
    config: params.cfg,
    env,
  });
  const bundledPluginIdSet = new Set(bundledPluginIds);
  const scopedPluginIds = onlyPluginIds
    ? onlyPluginIds.filter((pluginId) => bundledPluginIdSet.has(pluginId))
    : bundledPluginIds;
  if (scopedPluginIds.length === 0) {
    return [];
  }

  const providers = (
    await resolvePluginDiscoveryProviders({
      config: params.cfg,
      env,
      onlyPluginIds: scopedPluginIds,
      includeUntrustedWorkspacePlugins: false,
      requireCompleteDiscoveryEntryCoverage: params.staticOnly === true,
      discoveryEntriesOnly: params.staticOnly === true,
    })
  ).filter(
    (provider) =>
      typeof provider.pluginId === "string" && bundledPluginIdSet.has(provider.pluginId),
  );
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const rows: Model<Api>[] = [];
  const seen = new Set<string>();

  for (const order of DISCOVERY_ORDERS) {
    for (const provider of byOrder[order] ?? []) {
      if (!providerFilter && SELF_HOSTED_DISCOVERY_PROVIDER_IDS.has(provider.id)) {
        continue;
      }
      let result: Awaited<ReturnType<typeof runProviderStaticCatalog>> | null;
      try {
        result = await runProviderStaticCatalog({
          provider,
          config: params.cfg,
          agentDir: params.agentDir,
          env,
        });
      } catch (error) {
        log.warn(`provider static catalog failed for ${provider.id}: ${formatErrorMessage(error)}`);
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
