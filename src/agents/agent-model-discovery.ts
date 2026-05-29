import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
} from "../plugins/provider-runtime.js";
import { isRecord } from "../utils.js";
import {
  resolveAgentCredentialsForDiscovery,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
  type DiscoverAuthStorageOptions,
} from "./agent-auth-discovery.js";
import { resolveModelPluginMetadataSnapshot } from "./model-discovery-context.js";
import type { PluginModelCatalogMetadataSnapshot } from "./plugin-model-catalog.js";
import { normalizeProviderId } from "./provider-id.js";
import {
  AuthStorage,
  ModelRegistry,
  type AuthStorage as AgentAuthStorage,
  type ModelRegistry as AgentModelRegistry,
} from "./sessions/index.js";

export { AuthStorage, ModelRegistry };

type ProviderRuntimeModelLike = Model & {
  contextTokens?: number;
};

type DiscoveredProviderRuntimeModelLike = Omit<ProviderRuntimeModelLike, "api"> & {
  api?: string | null;
};

type DiscoverModelsOptions = {
  config?: OpenClawConfig;
  providerFilter?: string;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  workspaceDir?: string;
  normalizeModels?: boolean;
};

export function normalizeDiscoveredAgentModel<T>(value: T, agentDir: string): T {
  if (!isRecord(value)) {
    return value;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.provider !== "string"
  ) {
    return value;
  }
  const model = value as unknown as DiscoveredProviderRuntimeModelLike;
  const pluginNormalized =
    normalizeProviderResolvedModelWithPlugin({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: model as unknown as ProviderRuntimeModelLike,
        agentDir,
      },
    }) ?? model;
  const transportNormalized =
    applyProviderResolvedTransportWithPlugin({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: pluginNormalized as unknown as ProviderRuntimeModelLike,
        agentDir,
      },
    }) ?? pluginNormalized;
  if (
    !isRecord(transportNormalized) ||
    typeof transportNormalized.id !== "string" ||
    typeof transportNormalized.name !== "string" ||
    typeof transportNormalized.provider !== "string" ||
    typeof transportNormalized.api !== "string"
  ) {
    return value;
  }
  return normalizeModelCompat(transportNormalized as Model) as T;
}

function createOpenClawModelRegistry(
  authStorage: AgentAuthStorage,
  modelsJsonPath: string,
  agentDir: string,
  options?: DiscoverModelsOptions,
): AgentModelRegistry {
  const pluginMetadataSnapshot = resolveModelPluginMetadataSnapshot({
    ...(options?.config ? { config: options.config } : {}),
    ...(options?.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: options.pluginMetadataSnapshot }
      : {}),
    ...(options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    allowWorkspaceScopedCurrent: options?.workspaceDir === undefined,
    useRuntimeConfig: options?.config === undefined,
  });
  const registryOptions = pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {};
  const registry = ModelRegistry.create(authStorage, modelsJsonPath, registryOptions);
  const getAll = registry.getAll.bind(registry);
  const getAvailable = registry.getAvailable.bind(registry);
  const find = registry.find.bind(registry);
  const refresh = registry.refresh.bind(registry);
  const providerFilter = options?.providerFilter ? normalizeProviderId(options.providerFilter) : "";
  const matchesProviderFilter = (entry: Model) =>
    !providerFilter || normalizeProviderId(entry.provider) === providerFilter;
  const shouldNormalize = options?.normalizeModels !== false;
  const findCache = new Map<string, Model | undefined>();
  const normalizeEntry = (entry: Model) =>
    shouldNormalize ? normalizeDiscoveredAgentModel(entry, agentDir) : entry;

  registry.getAll = () => {
    const entries = getAll().filter((entry: Model) => matchesProviderFilter(entry));
    return shouldNormalize
      ? entries.map((entry: Model) => normalizeDiscoveredAgentModel(entry, agentDir))
      : entries;
  };
  registry.getAvailable = () => {
    const entries = getAvailable().filter((entry: Model) => matchesProviderFilter(entry));
    return shouldNormalize
      ? entries.map((entry: Model) => normalizeDiscoveredAgentModel(entry, agentDir))
      : entries;
  };
  registry.find = (provider: string, modelId: string) => {
    const normalizedProvider = normalizeProviderId(provider);
    const key = `${normalizedProvider}\0${modelId}`;
    if (findCache.has(key)) {
      return findCache.get(key);
    }
    const fallbackEntry = find(provider, modelId);
    const resolved = fallbackEntry ? normalizeEntry(fallbackEntry) : undefined;
    findCache.set(key, resolved);
    return resolved;
  };
  registry.refresh = () => {
    findCache.clear();
    return refresh();
  };

  return registry;
}

export function discoverAuthStorage(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): AgentAuthStorage {
  const credentials =
    options?.skipCredentials === true ? {} : resolveAgentCredentialsForDiscovery(agentDir, options);
  const authPath = path.join(agentDir, "auth.json");
  if (options?.readOnly !== true) {
    scrubLegacyStaticAuthJsonEntriesForDiscovery(authPath);
  }
  return AuthStorage.inMemory(credentials);
}

export function discoverModels(
  authStorage: AgentAuthStorage,
  agentDir: string,
  options?: DiscoverModelsOptions,
): AgentModelRegistry {
  return createOpenClawModelRegistry(
    authStorage,
    path.join(agentDir, "models.json"),
    agentDir,
    options,
  );
}

export {
  addEnvBackedAgentCredentials,
  resolveAgentCredentialsForDiscovery,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
  type DiscoverAuthStorageOptions,
} from "./agent-auth-discovery.js";
