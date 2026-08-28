import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  toStaticCatalogEntry,
  type PreparedConfiguredRuntimeModel,
  type PreparedRuntimeCapabilityModel,
} from "./prepared-model-runtime.configured.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type ConfiguredCatalogAgentFacts = {
  configuredModelRefs: readonly ModelCatalogRef[];
  runtimeCapabilityModels: readonly PreparedRuntimeCapabilityModel[];
};

type ConfiguredCatalogWorkspaceFacts = {
  configuredCatalogEntries: readonly ModelCatalogEntry[];
  inlineProviderModels: readonly InlineModelEntry[];
};

type ConfiguredRuntimeFacts = {
  templateModelRegistry: ModelRegistry;
  modelCatalog: ModelCatalogSnapshot;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  inlineProviderModels: readonly InlineModelEntry[];
};

export function modelCatalogEntryKey(entry: Pick<ModelCatalogEntry, "id" | "provider">): string {
  return `${normalizeProviderId(entry.provider)}\0${entry.id.trim().toLowerCase()}`;
}

function createConfiguredModelCatalogSnapshot(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): ModelCatalogSnapshot {
  const entries = new Map<string, ModelCatalogEntry>();
  const addEntry = (entry: ModelCatalogEntry) => {
    const key = modelCatalogEntryKey(entry);
    if (!entries.has(key)) {
      entries.set(key, entry);
    }
  };
  for (const entry of params.workspaceFacts.configuredCatalogEntries) {
    addEntry(entry);
  }
  for (const configured of params.configuredRuntimeModels) {
    addEntry(toStaticCatalogEntry(configured.model));
  }
  for (const { provider, modelId } of params.agentFacts.configuredModelRefs) {
    const model = params.templateModelRegistry.find(provider, modelId);
    if (model) {
      addEntry(toStaticCatalogEntry(model));
    }
  }
  const configuredEntries = [...entries.values()];
  const materializedEntries = materializeRuntimeCapabilities(
    configuredEntries,
    params.agentFacts.runtimeCapabilityModels,
  );
  const staticEntries = materializeRuntimeCapabilities(
    params.configuredRuntimeModels.map(({ model }) => toStaticCatalogEntry(model)),
    params.agentFacts.runtimeCapabilityModels,
  );
  return {
    entries: materializedEntries,
    routeVariants: materializedEntries,
    ...(staticEntries.length > 0 ? { staticEntries } : {}),
  };
}

/**
 * Configured views omit runtime-only rows. Retain the concrete route's
 * capabilities on the logical row so downstream projections do not rediscover
 * or depend on an absent runtime sibling.
 */
export function materializeRuntimeCapabilities(
  entries: readonly ModelCatalogEntry[],
  runtimeCapabilityModels: readonly PreparedRuntimeCapabilityModel[],
): ModelCatalogEntry[] {
  const runtimeByKey = new Map(
    runtimeCapabilityModels.map(({ provider, modelId, model }) => [
      modelCatalogEntryKey({ provider, id: modelId }),
      toStaticCatalogEntry(model),
    ]),
  );
  return entries.map((entry) => {
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
}

export function prepareConfiguredRuntimeFacts(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): ConfiguredRuntimeFacts {
  return {
    templateModelRegistry: params.templateModelRegistry,
    modelCatalog: createConfiguredModelCatalogSnapshot(params),
    configuredRuntimeModels: params.configuredRuntimeModels,
    inlineProviderModels: params.workspaceFacts.inlineProviderModels,
  };
}
