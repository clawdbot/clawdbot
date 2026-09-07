import { registryContainsRuntimePluginIds } from "../plugins/active-runtime-registry.js";
import { PluginRegistryResourceScope } from "../plugins/registry-resources.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { augmentPreparedModelCatalogWithAgentHarness } from "./harness/model-catalog.js";
import { resolveAgentRuntimePluginLoadPlan } from "./harness/runtime-plugin-load-plan.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

const generationResources = resolveGlobalSingleton(
  Symbol.for("openclaw.preparedPluginGenerationResources"),
  () => new WeakMap<PreparedModelRuntimePluginGeneration, PluginRegistryResourceScope>(),
);

/** Records source facts without making the generation object itself an unreleasable claim. */
export function associatePreparedPluginGenerationResources(
  generation: PreparedModelRuntimePluginGeneration,
  resources: PluginRegistryResourceScope,
): void {
  const previous = generationResources.get(generation);
  if (previous) {
    if (previous !== resources) {
      resources.retainFrom(previous);
    }
    return;
  }
  generationResources.set(generation, resources);
}

export function retainPreparedPluginGenerationResources(
  generation: PreparedModelRuntimePluginGeneration,
): PluginRegistryResourceScope {
  const existing = generationResources.get(generation);
  if (existing) {
    return existing.fork();
  }
  const resources = new PluginRegistryResourceScope();
  try {
    if (generation.pluginRegistry) {
      resources.retain(generation.pluginRegistry);
    }
    if (generation.inboundPluginRegistry) {
      resources.retain(generation.inboundPluginRegistry);
    }
    return resources;
  } catch (error) {
    resources.release();
    throw error;
  }
}

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
  const plan = resolveAgentRuntimePluginLoadPlan({
    config: input.config,
    workspaceDir:
      generation.pluginMetadataSnapshot.workspaceDir ?? input.workspaceDir ?? process.cwd(),
    selections: input.runtimePluginSelections,
    metadataSnapshot: generation.pluginMetadataSnapshot,
  });
  // Failed loads are recorded generation outcomes, not missing owners. Preserve their
  // diagnostics without making unrelated configured harnesses a condition of borrowing.
  return (
    registry !== undefined &&
    (plan.pluginIds ?? []).every(
      (id) =>
        registry.plugins.some((plugin) => plugin.id === id && plugin.status === "error") ||
        registryContainsRuntimePluginIds(registry, [id]),
    )
  );
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
  providerOutcomes?: Parameters<typeof buildPreparedModelCatalogSnapshot>[0]["providerOutcomes"];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}) {
  const { credentials, input } = params.agentFacts;
  const { pluginMetadataSnapshot: metadataSnapshot, pluginRegistry } = params.pluginGeneration;
  return await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, async () => {
    const snapshot = await buildPreparedModelCatalogSnapshot({
      agentDir: input.agentDir,
      authCredentials: credentials,
      config: input.config,
      modelRegistry: params.modelRegistry,
      metadataSnapshot,
      providerOutcomes: params.providerOutcomes,
      includeProviderPluginAugmentation: params.catalogMode === "live",
      ...(input.env ? { env: input.env } : {}),
      ...(input.readOnly ? { readOnly: true } : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
    return params.catalogMode === "live"
      ? await augmentPreparedModelCatalogWithAgentHarness({
          input,
          snapshot,
          pluginRegistry,
        })
      : snapshot;
  });
}
