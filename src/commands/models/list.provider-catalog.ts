/** Lifecycle-owned provider catalog projection for model-list output. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentDir, resolveDefaultAgentDir } from "../../agents/agent-scope.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { canonicalizeModelCatalogProviderAlias } from "./provider-aliases.js";

type ProviderCatalogListParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir: string;
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
    agentDir: params.agentDir,
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
  metadataSnapshot: PluginMetadataSnapshot,
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

/** Returns true when the prepared generation contains rows for a provider filter. */
export async function hasProviderRuntimeCatalogForFilter(
  params: Omit<ProviderCatalogListParams, "agentDir"> & { agentDir?: string },
): Promise<boolean> {
  const owner = await loadProviderCatalogSnapshot({
    ...params,
    agentDir: resolveProviderCatalogAgentDir(params),
  });
  const providerFilter = resolveProviderFilter(
    { ...params, agentDir: owner.agentDir },
    owner.metadataSnapshot,
  );
  return owner.modelCatalog.entries.some(
    (entry) => normalizeProviderId(entry.provider) === providerFilter,
  );
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
