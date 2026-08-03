import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  prepareAgentCatalogSource,
  prepareFullCatalogFacts,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
} from "./prepared-model-runtime.types.js";

async function prepareScopedReadOnlyModelCatalogWithMode(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
  catalogMode: PreparedModelRuntimeCatalogMode,
): Promise<ModelCatalogSnapshot> {
  const scopedInput = input.readOnly ? input : { ...input, readOnly: true };
  const { agentFacts, workspaceFacts } = await prepareWorkspaceBuildGroup(
    [scopedInput],
    catalogMode,
    { providerDiscoveryProviderIds },
  );
  const agentFactsForInput = agentFacts[0];
  if (!agentFactsForInput) {
    throw new Error("scoped prepared model catalog facts are missing");
  }
  const catalogSource = await prepareAgentCatalogSource(
    agentFactsForInput,
    workspaceFacts,
    catalogMode,
    false,
    catalogMode === "live" ? { providerDiscoveryProviderIds } : {},
  );
  return (
    await prepareFullCatalogFacts(agentFactsForInput, workspaceFacts, catalogMode, catalogSource)
  ).modelCatalog;
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
