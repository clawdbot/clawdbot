/** Provider catalog projection for model-list output. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { loadAuthProfileStoreForSecretsRuntime } from "../../agents/auth-profiles/store.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { buildInlineProviderModels } from "../../agents/embedded-agent-runner/model.inline-provider.js";
import { resolveImplicitProviders } from "../../agents/models-config.providers.implicit.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "../../agents/prepared-model-catalog.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { canonicalizeModelCatalogProviderAlias } from "./provider-aliases.js";

type ProviderCatalogListParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  providerFilter?: string;
  staticOnly?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
};

const SELF_HOSTED_DISCOVERY_PROVIDER_IDS = new Set(["lmstudio", "ollama", "sglang", "vllm"]);

async function loadProviderCatalogSnapshot(
  params: ProviderCatalogListParams,
  options: { readOnly?: boolean } = {},
) {
  const input = {
    config: params.cfg,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    agentDir: resolveProviderCatalogAgentDir(params),
    ...(params.metadataSnapshot?.workspaceDir
      ? { workspaceDir: params.metadataSnapshot.workspaceDir }
      : {}),
    ...(params.env ? { env: params.env } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
  };
  return await loadPreparedModelCatalogOwnerSnapshot(input);
}

function resolveProviderFilter(
  params: ProviderCatalogListParams,
  metadataSnapshot?: PluginMetadataSnapshot,
): string {
  const providerFilter = normalizeProviderId(params.providerFilter ?? "");
  return providerFilter
    ? normalizeProviderId(
        canonicalizeModelCatalogProviderAlias(providerFilter, {
          cfg: params.cfg,
          metadataSnapshot,
        }),
      )
    : providerFilter;
}

function resolveProviderCatalogMetadataSnapshot(
  params: ProviderCatalogListParams,
): PluginMetadataSnapshot {
  if (params.metadataSnapshot) {
    return params.metadataSnapshot;
  }
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const workspaceDir =
    resolveAgentWorkspaceDir(params.cfg, agentId) ?? resolveDefaultAgentWorkspaceDir();
  return loadManifestMetadataSnapshot({
    config: params.cfg,
    env: params.env ?? process.env,
    workspaceDir,
  });
}

function resolveProviderCatalogAgentDir(
  params: Omit<ProviderCatalogListParams, "agentDir"> & { agentDir?: string },
): string {
  return (
    params.agentDir ??
    (params.agentId
      ? resolveAgentDir(params.cfg, params.agentId, params.env)
      : resolveDefaultAgentDir(params.cfg, params.env))
  );
}

function completeCatalogModel(model: ReturnType<typeof buildInlineProviderModels>[number]): Model {
  const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_TOKENS;
  return {
    ...model,
    name: model.name || model.id,
    api: model.api ?? "openai-responses",
    baseUrl: model.baseUrl ?? "",
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
  } as Model;
}

async function loadScopedProviderCatalogModels(
  params: ProviderCatalogListParams,
): Promise<Model[]> {
  const metadataSnapshot = resolveProviderCatalogMetadataSnapshot(params);
  const providerFilter = resolveProviderFilter(params, metadataSnapshot);
  if (!providerFilter) {
    return [];
  }
  const agentDir = resolveProviderCatalogAgentDir(params);
  const providers = await resolveImplicitProviders({
    agentDir,
    authStore: loadAuthProfileStoreForSecretsRuntime(agentDir, {
      config: params.cfg,
      externalCliProviderIds: [providerFilter],
    }),
    config: params.cfg,
    explicitProviders: params.cfg.models?.providers ?? null,
    providerDiscoveryProviderIds: [providerFilter],
    ...(params.env ? { env: params.env } : {}),
    ...(metadataSnapshot.workspaceDir ? { workspaceDir: metadataSnapshot.workspaceDir } : {}),
    pluginMetadataSnapshot: metadataSnapshot,
  });
  return buildInlineProviderModels(providers ?? {})
    .filter((model) => normalizeProviderId(model.provider) === providerFilter)
    .map(completeCatalogModel);
}

/** Returns true when manifest ownership exposes a runtime catalog for the provider filter. */
export async function hasProviderRuntimeCatalogForFilter(
  params: Omit<ProviderCatalogListParams, "agentDir"> & { agentDir?: string },
): Promise<boolean> {
  const resolvedParams = {
    ...params,
    agentDir: resolveProviderCatalogAgentDir(params),
  };
  const metadataSnapshot = resolveProviderCatalogMetadataSnapshot(resolvedParams);
  const providerFilter = resolveProviderFilter(resolvedParams, metadataSnapshot);
  if (!providerFilter) {
    return false;
  }
  return Boolean(metadataSnapshot.owners.modelCatalogProviders.get(providerFilter)?.length);
}

/** Returns true when the prepared generation captured static provider-hook rows. */
export async function hasProviderStaticCatalogForFilter(
  params: Omit<ProviderCatalogListParams, "agentDir"> & { agentDir?: string },
): Promise<boolean> {
  const resolvedParams = {
    ...params,
    agentDir: resolveProviderCatalogAgentDir(params),
  };
  const owner = await loadProviderCatalogSnapshot(resolvedParams, { readOnly: true });
  const providerFilter = resolveProviderFilter(resolvedParams, owner.metadataSnapshot);
  return (owner.modelCatalog.staticEntries ?? []).some(
    (entry) => !providerFilter || normalizeProviderId(entry.provider) === providerFilter,
  );
}

/** Projects provider rows from the committed model catalog without discovery or cache IO. */
export async function loadProviderCatalogModelsForList(
  params: ProviderCatalogListParams,
): Promise<Model[]> {
  if (params.providerFilter && params.staticOnly !== true) {
    return await loadScopedProviderCatalogModels(params);
  }
  const owner = await loadProviderCatalogSnapshot(params, {
    readOnly: params.staticOnly === true,
  });
  const providerFilter = resolveProviderFilter(params, owner.metadataSnapshot);
  const entries = params.staticOnly
    ? (owner.modelCatalog.staticEntries ?? [])
    : owner.modelCatalog.entries;
  return entries
    .filter((entry) => {
      const provider = normalizeProviderId(entry.provider);
      if (!providerFilter && SELF_HOSTED_DISCOVERY_PROVIDER_IDS.has(provider)) {
        return false;
      }
      return !providerFilter || provider === providerFilter;
    })
    .map((entry) => Object.assign({}, entry) as Model);
}
