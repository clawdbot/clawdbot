import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  prepareAgentCatalogSource,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import {
  materializePreparedModelCatalog,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
} from "./prepared-model-runtime.types.js";

async function prepareScopedReadOnlyModelCatalogWithMode(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
  catalogMode: PreparedModelRuntimeCatalogMode,
): Promise<ModelCatalogSnapshot> {
  const scopedInput =
    input.readOnly && catalogMode !== "live"
      ? input
      : {
          ...input,
          ...(catalogMode === "live" ? { loadRuntimePlugins: true } : {}),
          readOnly: true,
        };
  const { agentFacts, pluginGeneration } = await prepareWorkspaceBuildGroup(
    [scopedInput],
    catalogMode,
    { providerDiscoveryProviderIds },
  );
  const agentFactsForInput = agentFacts[0];
  if (!agentFactsForInput) {
    throw new Error("scoped prepared model catalog facts are missing");
  }
  const catalogSource =
    catalogMode === "live"
      ? await prepareAgentCatalogSource(agentFactsForInput, pluginGeneration, catalogMode, false, {
          providerDiscoveryProviderIds,
        })
      : undefined;
  const { modelCatalog } = await prepareFullCatalogFacts(
    agentFactsForInput,
    pluginGeneration,
    catalogMode,
    catalogSource,
  );
  return materializePreparedModelCatalog(modelCatalog, agentFactsForInput.runtimeCapabilityModels);
}

/** Builds a request-scoped read-only catalog without executing live provider discovery. */
export function prepareScopedReadOnlyModelCatalog(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
): Promise<ModelCatalogSnapshot> {
  return prepareScopedReadOnlyModelCatalogWithMode(input, providerDiscoveryProviderIds, "static");
}

/** Builds a request-scoped read-only catalog with live discovery for selected providers. */
export function prepareScopedReadOnlyLiveModelCatalog(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
): Promise<ModelCatalogSnapshot> {
  return prepareScopedReadOnlyModelCatalogWithMode(input, providerDiscoveryProviderIds, "live");
}
