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
import { modelCatalogEntryKey } from "./prepared-model-runtime.configured-catalog.js";
import { completeConfiguredRuntimeModels } from "./prepared-model-runtime.configured-completion.js";
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
  const configuredRuntimeModels = completeConfiguredRuntimeModels(
    agentFacts,
    pluginGeneration,
    templateModelRegistry,
  );
  const staticModels = [
    ...configuredRuntimeModels.map(({ model }) => model),
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
    configuredRuntimeModels,
    inlineProviderModels: pluginGeneration.inlineProviderModels,
  };
}

/** Reprojects retained inventory without carrying capabilities from a retired runtime. */
export function materializePreparedModelCatalog(
  snapshot: ModelCatalogSnapshot,
  runtimeCapabilityModels: readonly PreparedRuntimeCapabilityModel[],
): ModelCatalogSnapshot {
  // Preserve inventory reads before capability preparation when the snapshot has accessors.
  const materialized = { ...snapshot };
  const sourceEntries = snapshot.entries;
  const runtimeByKey = new Map(
    runtimeCapabilityModels.map(({ provider, modelId, model }) => [
      modelCatalogEntryKey({ provider, id: modelId }),
      toStaticCatalogEntry(model),
    ]),
  );
  const project = (entries: ModelCatalogSnapshot["entries"]) =>
    entries.map((entry) => {
      const runtime = runtimeByKey.get(modelCatalogEntryKey(entry));
      if (!runtime) {
        return entry;
      }
      const thinkingPolicyProvider = runtime.provider;
      if (entry.configuredReasoning !== undefined) {
        return { ...entry, thinkingPolicyProvider };
      }
      const params =
        runtime.params || entry.params ? { ...runtime.params, ...entry.params } : undefined;
      const compat =
        runtime.compat || entry.compat ? { ...runtime.compat, ...entry.compat } : undefined;
      return {
        ...entry,
        thinkingPolicyProvider,
        ...(runtime.reasoning !== undefined ? { reasoning: runtime.reasoning } : {}),
        ...(params ? { params } : {}),
        ...(compat ? { compat } : {}),
      };
    });
  materialized.entries = project(sourceEntries);
  materialized.routeVariants = project(snapshot.routeVariants);
  if (snapshot.staticEntries) {
    materialized.staticEntries = project(snapshot.staticEntries);
  }
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
