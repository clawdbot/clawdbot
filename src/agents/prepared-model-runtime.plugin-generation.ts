import {
  listRuntimePluginIdsFromRegistry,
  registryContainsRuntimePluginIds,
} from "../plugins/active-runtime-registry.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { augmentPreparedModelCatalogWithAgentHarness } from "./harness/model-catalog.js";
import {
  resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelections,
} from "./harness/runtime-plugin-load-plan.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

// Lineage is cache identity only. Derived generations still require the exact open
// parent lease at admission; they never become configured publication authority.
const derivedGenerationBases = new WeakMap<
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimePluginGeneration
>();

/** Borrowing may narrow a prepared selection, but cannot acquire a different plugin owner. */
export function preparedPluginGenerationSupportsSelections(
  generation: PreparedModelRuntimePluginGeneration,
  input: PreparedModelRuntimeInput,
): boolean {
  if (!input.runtimePluginSelections) {
    return true;
  }
  const registry = generation.pluginRegistry;
  if (!registry) {
    return false;
  }
  const plan = resolveAgentRuntimePluginLoadPlan({
    config: input.config,
    workspaceDir:
      generation.pluginMetadataSnapshot.workspaceDir ?? input.workspaceDir ?? process.cwd(),
    basePluginIds: listRuntimePluginIdsFromRegistry(registry),
    selections: resolveAgentRuntimePluginSelections(input.config, input.runtimePluginSelections),
    metadataSnapshot: generation.pluginMetadataSnapshot,
  });
  return registryContainsRuntimePluginIds(registry, plan.pluginIds);
}

export function preparedPluginGenerationReusesBase(
  generation: PreparedModelRuntimePluginGeneration | undefined,
  base: PreparedModelRuntimePluginGeneration,
): boolean {
  return (
    generation === base ||
    (generation !== undefined && derivedGenerationBases.get(generation) === base)
  );
}

export function createPreparedPluginGeneration(params: {
  catalogMode: PreparedModelRuntimeCatalogMode;
  configuredCatalogEntries: PreparedModelRuntimePluginGeneration["configuredCatalogEntries"];
  inboundPluginRegistry: PreparedModelRuntimePluginGeneration["inboundPluginRegistry"];
  inlineProviderModels: PreparedModelRuntimePluginGeneration["inlineProviderModels"];
  mediaCapabilityProviders: PreparedModelRuntimePluginGeneration["mediaCapabilityProviders"];
  messageToolCatalog: PreparedModelRuntimePluginGeneration["messageToolCatalog"];
  pluginMetadataSnapshot: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"];
  preparedStaticProviderCatalog: PreparedModelRuntimePluginGeneration["preparedStaticProviderCatalog"];
  providerStaticModels: PreparedModelRuntimePluginGeneration["providerStaticModels"];
  preferBuiltPluginArtifacts?: boolean;
  reusablePluginGeneration?: PreparedModelRuntimePluginGeneration;
  runtimePluginRegistry: PreparedModelRuntimePluginGeneration["pluginRegistry"];
}): PreparedModelRuntimePluginGeneration {
  const reusable = params.reusablePluginGeneration;
  if (reusable) {
    if (
      params.pluginMetadataSnapshot === reusable.pluginMetadataSnapshot &&
      params.runtimePluginRegistry === reusable.pluginRegistry
    ) {
      return reusable;
    }
    const derived = Object.freeze({
      ...reusable,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      pluginRegistry: params.runtimePluginRegistry,
      mediaCapabilityProviders: params.mediaCapabilityProviders,
      messageToolCatalog: params.messageToolCatalog,
      preparedStaticProviderCatalog: params.preparedStaticProviderCatalog,
    });
    if (params.pluginMetadataSnapshot === reusable.pluginMetadataSnapshot) {
      derivedGenerationBases.set(derived, reusable);
    }
    return derived;
  }
  return Object.freeze({
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    inlineProviderModels: Object.freeze([...params.inlineProviderModels]),
    configuredCatalogEntries: Object.freeze([...params.configuredCatalogEntries]),
    ...(params.messageToolCatalog ? { messageToolCatalog: params.messageToolCatalog } : {}),
    ...(params.runtimePluginRegistry ? { pluginRegistry: params.runtimePluginRegistry } : {}),
    ...(params.inboundPluginRegistry
      ? { inboundPluginRegistry: params.inboundPluginRegistry }
      : {}),
    ...(params.preferBuiltPluginArtifacts ? { preferBuiltPluginArtifacts: true } : {}),
    ...(params.mediaCapabilityProviders
      ? { mediaCapabilityProviders: params.mediaCapabilityProviders }
      : {}),
    ...(params.preparedStaticProviderCatalog
      ? { preparedStaticProviderCatalog: params.preparedStaticProviderCatalog }
      : {}),
    ...(params.catalogMode === "live"
      ? { providerStaticModels: Object.freeze([...(params.providerStaticModels ?? [])]) }
      : {}),
  });
}

export async function buildPreparedPluginModelCatalog(params: {
  agentFacts: {
    credentials: Parameters<typeof buildPreparedModelCatalogSnapshot>[0]["authCredentials"];
    input: PreparedModelRuntimeInput;
  };
  catalogMode: PreparedModelRuntimeCatalogMode;
  modelRegistry: Parameters<typeof buildPreparedModelCatalogSnapshot>[0]["modelRegistry"];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}) {
  const { credentials, input } = params.agentFacts;
  const { pluginMetadataSnapshot: metadataSnapshot, pluginRegistry } = params.pluginGeneration;
  return await withPluginRuntimeGenerationScope(
    { config: input.config, metadataSnapshot, pluginRegistry },
    async () => {
      const snapshot = await buildPreparedModelCatalogSnapshot({
        agentDir: input.agentDir,
        authCredentials: credentials,
        config: input.config,
        modelRegistry: params.modelRegistry,
        metadataSnapshot,
        includeProviderPluginAugmentation: params.catalogMode === "live",
        ...(input.env ? { env: input.env } : {}),
        ...(input.readOnly ? { readOnly: true } : {}),
        ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      });
      return params.catalogMode === "live"
        ? await augmentPreparedModelCatalogWithAgentHarness({
            input,
            snapshot,
            metadataSnapshot,
            pluginRegistry,
          })
        : snapshot;
    },
  );
}
