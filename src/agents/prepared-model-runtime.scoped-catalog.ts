import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  prepareAgentCatalogSource,
  prepareFullCatalogFacts,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

/** Builds a request-scoped read-only catalog from configured and auth-candidate providers. */
export async function prepareScopedReadOnlyModelCatalog(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
): Promise<ModelCatalogSnapshot> {
  const scopedInput = input.readOnly ? input : { ...input, readOnly: true };
  const { agentFacts, workspaceFacts } = await prepareWorkspaceBuildGroup([scopedInput], "static", {
    providerDiscoveryProviderIds,
  });
  const agentFactsForInput = agentFacts[0];
  if (!agentFactsForInput) {
    throw new Error("scoped prepared model catalog facts are missing");
  }
  const catalogSource = await prepareAgentCatalogSource(
    agentFactsForInput,
    workspaceFacts,
    "static",
    false,
  );
  return (
    await prepareFullCatalogFacts(agentFactsForInput, workspaceFacts, "static", catalogSource)
  ).modelCatalog;
}
