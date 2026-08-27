import type { ConfiguredModelRef } from "@openclaw/model-catalog-core/configured-model-refs";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PersistedPluginModelCatalog } from "./plugin-model-catalog.js";
import type {
  PreparedConfiguredRuntimeModel,
  PreparedRuntimeCapabilityModel,
} from "./prepared-model-runtime.configured.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import type { AuthStorage, AuthStorageData } from "./sessions/auth-storage.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

export type PreparedModelRuntimeAgentBaseFacts = {
  input: PreparedModelRuntimeInput;
  env: NodeJS.ProcessEnv;
  authStore: AuthProfileStore;
  templateAuthStorage: AuthStorage;
  credentials: Readonly<AuthStorageData>;
  providerIds: string[];
  configuredModelRefs: readonly ConfiguredModelRef[];
};

export type PreparedModelRuntimeAgentFacts = PreparedModelRuntimeAgentBaseFacts & {
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  runtimeCapabilityModels: readonly PreparedRuntimeCapabilityModel[];
  configuredGeneratedCatalogPluginIds: readonly string[];
};

export type PreparedModelRuntimeCatalogFacts = {
  templateModelRegistry: ModelRegistry;
  modelCatalog: ModelCatalogSnapshot;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  inlineProviderModels: readonly InlineModelEntry[];
};

export type PreparedModelRuntimeCatalogSource = Readonly<{
  modelsJsonContents: string | null;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
  providerOutcomes?: readonly ProviderCatalogOutcome[];
}>;
