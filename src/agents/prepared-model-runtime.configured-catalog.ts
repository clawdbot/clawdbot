import type { ConfiguredModelRef } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  toStaticCatalogEntry,
  type PreparedConfiguredRuntimeModel,
} from "./prepared-model-runtime.configured.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type ConfiguredCatalogAgentFacts = {
  configuredModelRefs: readonly ConfiguredModelRef[];
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
  for (const { value } of params.agentFacts.configuredModelRefs) {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator >= value.length - 1) {
      continue;
    }
    const provider = normalizeProviderId(value.slice(0, separator));
    const modelId = value.slice(separator + 1).trim();
    if (!provider || !modelId) {
      continue;
    }
    const model = params.templateModelRegistry.find(provider, modelId);
    if (model) {
      addEntry(toStaticCatalogEntry(model));
    }
  }
  const configuredEntries = [...entries.values()];
  const staticEntries = params.configuredRuntimeModels.map(({ model }) =>
    toStaticCatalogEntry(model),
  );
  return {
    entries: configuredEntries,
    routeVariants: configuredEntries,
    ...(staticEntries.length > 0 ? { staticEntries } : {}),
  };
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
