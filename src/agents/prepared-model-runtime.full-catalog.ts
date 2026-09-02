import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { discoverModels } from "./agent-model-discovery.js";
import { loadBundledProviderStaticCatalogContextModels } from "./embedded-agent-runner/model.static-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  getPreparedModelFullCatalogAuth,
  setPreparedModelFullCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import {
  materializeRuntimeCapabilities,
  modelCatalogEntryKey,
} from "./prepared-model-runtime.configured-catalog.js";
import {
  toStaticCatalogEntry,
  type PreparedRuntimeCapabilityModel,
} from "./prepared-model-runtime.configured.js";
import { buildPreparedPluginModelCatalog } from "./prepared-model-runtime.plugin-generation.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

const fullModelCatalogSnapshots = new WeakSet<ModelCatalogSnapshot>();

/** Builds complete inventory before generation-specific runtime capability projection. */
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
  const modelCatalog = await buildPreparedPluginModelCatalog({
    agentFacts,
    catalogMode,
    modelRegistry: templateModelRegistry,
    pluginGeneration,
  });
  const providerStaticModels =
    pluginGeneration.providerStaticModels ??
    (await loadBundledProviderStaticCatalogContextModels({
      cfg: input.config,
      env,
      metadataSnapshot: pluginMetadataSnapshot,
      ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    }));
  const staticModels = [
    ...agentFacts.configuredRuntimeModels.map((configured) => configured.model),
    ...providerStaticModels,
  ];
  const providerOutcomes = catalogSource?.providerOutcomes ?? [];
  const completeModelCatalog = {
    ...modelCatalog,
    staticEntries: dedupeByKey(staticModels, modelCatalogEntryKey).map(toStaticCatalogEntry),
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

/** Reprojects retained inventory without carrying capabilities from a retired runtime. */
export function materializePreparedModelCatalog(
  snapshot: ModelCatalogSnapshot,
  runtimeCapabilityModels: readonly PreparedRuntimeCapabilityModel[],
): ModelCatalogSnapshot {
  const project = (entries: ModelCatalogSnapshot["entries"]) =>
    materializeRuntimeCapabilities(entries, runtimeCapabilityModels);
  const materialized = {
    ...snapshot,
    entries: project(snapshot.entries),
    routeVariants: project(snapshot.routeVariants),
    ...(snapshot.staticEntries ? { staticEntries: project(snapshot.staticEntries) } : {}),
  };
  if (isPreparedModelCatalogFull(snapshot)) {
    markPreparedModelCatalogFull(materialized);
  }
  const auth = getPreparedModelFullCatalogAuth(snapshot);
  if (auth) {
    setPreparedModelFullCatalogAuth(materialized, auth);
  }
  return materialized;
}

/** Reports whether a catalog came from the complete prepared-catalog build path. */
export const isPreparedModelCatalogFull = (snapshot: ModelCatalogSnapshot): boolean =>
  fullModelCatalogSnapshots.has(snapshot);

/** Restores process-local provenance after a complete catalog crosses a worker boundary. */
export function markPreparedModelCatalogFull(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot {
  fullModelCatalogSnapshots.add(snapshot);
  return snapshot;
}
