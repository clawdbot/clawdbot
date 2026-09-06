import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { prepareAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import {
  prepareAgentCatalogSource,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";
import {
  materializePreparedModelCatalog,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import {
  listPreparedSyntheticAuthProviderRefs,
  prepareSyntheticAuth,
} from "./prepared-model-runtime.synthetic-auth.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
} from "./prepared-model-runtime.types.js";

type ScopedReadOnlyModelAuthInput = Pick<
  PreparedModelRuntimeInput,
  "config" | "env" | "workspaceDir"
>;

async function prepareScopedReadOnlyModelCatalogWithMode(
  input: PreparedModelRuntimeInput,
  providerDiscoveryProviderIds: readonly string[],
  catalogMode: PreparedModelRuntimeCatalogMode,
): Promise<ModelCatalogSnapshot> {
  const scopedInput = input.readOnly ? input : { ...input, readOnly: true };
  const { agentFacts, pluginGeneration } = await prepareWorkspaceBuildGroup(
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
    pluginGeneration,
    catalogMode,
    false,
    catalogMode === "live" ? { providerDiscoveryProviderIds } : {},
  );
  const { modelCatalog, configuredRuntimeModels } = await prepareFullCatalogFacts(
    agentFactsForInput,
    pluginGeneration,
    catalogMode,
    catalogSource,
  );
  return materializePreparedModelCatalog(
    modelCatalog,
    agentFactsForInput.runtimeCapabilityModels,
    configuredRuntimeModels,
  );
}

/** Resolves provider-scoped, secret-free auth modes without live model discovery. */
export async function prepareScopedReadOnlyModelAuthModes(
  input: ScopedReadOnlyModelAuthInput,
  providerDiscoveryProviderIds: readonly string[],
  pluginMetadataSnapshot: PluginMetadataSnapshot,
): Promise<PreparedAgentCredentialModes> {
  const providerIds = [
    ...new Set(providerDiscoveryProviderIds.map(normalizeProviderId).filter(Boolean)),
  ];
  const providers =
    (
      await prepareImplicitProviderStaticCatalog({
        config: input.config,
        env: input.env,
        pluginMetadataSnapshot,
        providerDiscoveryProviderIds: providerIds,
        staticCatalogProviderIds: providerIds,
        ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      })
    ).providers ?? [];
  const credentials = await prepareAmbientAgentCredentialsForDiscovery({
    config: input.config,
    env: input.env,
    authoritativeSyntheticAuthProviderRefs: pluginMetadataSnapshot.owners.cliBackends.keys(),
    syntheticAuthProviderRefs: listPreparedSyntheticAuthProviderRefs(providers),
    resolveSyntheticAuth: (provider) => prepareSyntheticAuth({ ...input, provider, providers }),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const modes = resolveUsableAgentCredentialModes(credentials);
  const scoped: Record<string, PreparedAgentCredentialModes[string]> = {};
  for (const provider of providerIds) {
    if (modes[provider]) {
      scoped[provider] = modes[provider];
    }
  }
  return scoped;
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
