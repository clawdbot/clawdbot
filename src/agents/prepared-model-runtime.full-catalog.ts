import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { discoverModels } from "./agent-model-discovery.js";
import { loadBundledProviderStaticCatalogContextModels } from "./embedded-agent-runner/model.static-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import { materializeRuntimeCapabilities } from "./prepared-model-runtime.configured-catalog.js";
import { toStaticCatalogEntry } from "./prepared-model-runtime.configured.js";
import { buildPreparedPluginModelCatalog } from "./prepared-model-runtime.plugin-generation.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

const fullModelCatalogSnapshots = new WeakSet<ModelCatalogSnapshot>();

/** Builds the complete prepared catalog, including concrete runtime capabilities. */
export async function prepareFullCatalogFacts(
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogMode: PreparedModelRuntimeCatalogMode,
  catalogSource?: PreparedModelRuntimeCatalogSource,
): Promise<PreparedModelRuntimeCatalogFacts> {
  const { env, input, templateAuthStorage } = agentFacts;
  const { pluginMetadataSnapshot, preparedStaticProviderCatalog } = pluginGeneration;
  const templateModelRegistry = discoverModels(templateAuthStorage, input.agentDir, {
    config: input.config,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    pluginMetadataSnapshot,
    ...(catalogMode === "static" ? { normalizeModels: false } : {}),
    ...(catalogSource
      ? {
          includePluginCatalogs: true,
          modelsJsonContents: catalogSource.modelsJsonContents,
          pluginCatalogs: catalogSource.pluginCatalogs,
        }
      : {}),
  });
  const discoveredCatalog = await buildPreparedPluginModelCatalog({
    agentFacts,
    catalogMode,
    modelRegistry: templateModelRegistry,
    pluginGeneration,
  });
  const modelCatalog = {
    ...discoveredCatalog,
    entries: materializeRuntimeCapabilities(
      discoveredCatalog.entries,
      agentFacts.runtimeCapabilityModels,
    ),
    routeVariants: materializeRuntimeCapabilities(
      discoveredCatalog.routeVariants,
      agentFacts.runtimeCapabilityModels,
    ),
  };
  const providerStaticModels =
    pluginGeneration.providerStaticModels ??
    (await loadBundledProviderStaticCatalogContextModels({
      cfg: input.config,
      env,
      metadataSnapshot: pluginMetadataSnapshot,
      ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    }));
  const staticModels = new Map<string, ProviderRuntimeModel>();
  for (const model of [
    ...agentFacts.configuredRuntimeModels.map((configured) => configured.model),
    ...providerStaticModels,
  ]) {
    const modelKey = `${normalizeProviderId(model.provider)}\0${model.id.trim().toLowerCase()}`;
    if (!staticModels.has(modelKey)) {
      staticModels.set(modelKey, model);
    }
  }
  const staticEntries = materializeRuntimeCapabilities(
    [...staticModels.values()].map(toStaticCatalogEntry),
    agentFacts.runtimeCapabilityModels,
  );
  const providerOutcomes = catalogSource?.providerOutcomes ?? [];
  const completeModelCatalog = {
    ...modelCatalog,
    staticEntries,
    ...(providerOutcomes.length > 0 ? { providerOutcomes } : {}),
  };
  if (catalogMode === "live") {
    fullModelCatalogSnapshots.add(completeModelCatalog);
  }
  return {
    templateModelRegistry,
    modelCatalog: completeModelCatalog,
    configuredRuntimeModels: agentFacts.configuredRuntimeModels,
    inlineProviderModels: pluginGeneration.inlineProviderModels,
  };
}

/** Reports whether a catalog came from the complete prepared-catalog build path. */
export const isPreparedModelCatalogFull = (snapshot: ModelCatalogSnapshot): boolean =>
  fullModelCatalogSnapshots.has(snapshot);

/** Restores process-local provenance after a complete catalog crosses a worker boundary. */
export function markPreparedModelCatalogFull(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot {
  fullModelCatalogSnapshots.add(snapshot);
  return snapshot;
}
