import type { Api, Model } from "@earendil-works/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planManifestModelCatalogRows } from "../../model-catalog/manifest-planner.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/types.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../../plugins/manifest-contract-eligibility.js";
import { normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { normalizeProviderId } from "../provider-id.js";

function rowMatchesModel(params: {
  row: NormalizedModelCatalogRow;
  provider: string;
  modelId: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (normalizeProviderId(params.row.provider) !== normalizedProvider) {
    return false;
  }
  return (
    normalizeStaticProviderModelId(normalizedProvider, params.row.id).trim().toLowerCase() ===
    normalizeStaticProviderModelId(normalizedProvider, params.modelId).trim().toLowerCase()
  );
}

function modelFromStaticCatalogRow(row: NormalizedModelCatalogRow): Model<Api> {
  return {
    id: row.id,
    name: row.name || row.id,
    provider: row.provider,
    api: row.api ?? "openai-responses",
    baseUrl: row.baseUrl,
    reasoning: row.reasoning,
    input: row.input,
    cost: row.cost,
    contextWindow: row.contextWindow,
    contextTokens: row.contextTokens,
    maxTokens: row.maxTokens,
    headers: row.headers,
    compat: row.compat,
  } as Model<Api>;
}

export function resolveBundledStaticCatalogModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Model<Api> | undefined {
  const provider = normalizeProviderId(params.provider);
  if (!provider || !params.modelId.trim()) {
    return undefined;
  }
  const config = params.cfg ?? {};
  const snapshot = loadManifestMetadataSnapshot({
    config,
    env: params.env ?? process.env,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  });
  const bundledStaticPlugins = snapshot.plugins.filter(
    (plugin) =>
      plugin.origin === "bundled" &&
      plugin.modelCatalog &&
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config,
      }),
  );
  if (bundledStaticPlugins.length === 0) {
    return undefined;
  }
  const plan = planManifestModelCatalogRows({
    registry: { plugins: bundledStaticPlugins },
    providerFilter: provider,
  });
  for (const entry of plan.entries) {
    if (entry.discovery !== "static") {
      continue;
    }
    const row = entry.rows.find((candidate) =>
      rowMatchesModel({
        row: candidate,
        provider,
        modelId: params.modelId,
      }),
    );
    if (row) {
      return modelFromStaticCatalogRow(row);
    }
  }
  return undefined;
}
