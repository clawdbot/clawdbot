import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "./capability-provider-runtime.js";
import {
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";

const OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID = "openai-compatible";
const OPENAI_COMPATIBLE_MODEL_APIS = new Set(["openai-completions", "openai-responses"]);

export { listRegisteredEmbeddingProviders };

export function listRegisteredEmbeddingProviderAdapters(): EmbeddingProviderAdapter[] {
  return listRegisteredEmbeddingProviders().map((entry) => entry.adapter);
}

export function listEmbeddingProviders(cfg?: OpenClawConfig): EmbeddingProviderAdapter[] {
  const registered = listRegisteredEmbeddingProviderAdapters();
  const merged = new Map(registered.map((adapter) => [adapter.id, adapter]));
  for (const adapter of resolvePluginCapabilityProviders({
    key: "embeddingProviders",
    cfg,
  })) {
    if (!merged.has(adapter.id)) {
      merged.set(adapter.id, adapter);
    }
  }
  return [...merged.values()];
}

function readConfiguredProviderApiId(providerId: string, cfg?: OpenClawConfig): string | undefined {
  const providers = cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const normalized = normalizeProviderId(providerId);
  const providerConfig =
    providers[providerId] ??
    Object.entries(providers).find(
      ([candidateId]) => normalizeProviderId(candidateId) === normalized,
    )?.[1];
  const api = providerConfig?.api?.trim();
  if (!api && providerConfig?.baseUrl?.trim()) {
    return OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID;
  }
  if (!api) {
    return undefined;
  }
  const normalizedApi = normalizeProviderId(api);
  const embeddingProviderId = OPENAI_COMPATIBLE_MODEL_APIS.has(normalizedApi)
    ? OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID
    : normalizedApi;
  return embeddingProviderId && embeddingProviderId !== normalized
    ? embeddingProviderId
    : undefined;
}

function resolveEmbeddingProviderLookupIds(id: string, cfg?: OpenClawConfig): string[] {
  const ids = [id];
  const apiId = readConfiguredProviderApiId(id, cfg);
  if (apiId && !ids.some((candidate) => normalizeProviderId(candidate) === apiId)) {
    ids.push(apiId);
  }
  return ids;
}

export function getEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): EmbeddingProviderAdapter | undefined {
  const ids = resolveEmbeddingProviderLookupIds(id, cfg);
  for (const candidateId of ids) {
    const registered = getRegisteredEmbeddingProvider(candidateId);
    if (registered) {
      return registered.adapter;
    }
  }
  for (const candidateId of ids) {
    const provider = resolvePluginCapabilityProvider({
      key: "embeddingProviders",
      providerId: candidateId,
      cfg,
    });
    if (provider) {
      return provider;
    }
  }
  return undefined;
}

export type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderRuntime,
  RegisteredEmbeddingProvider,
} from "./embedding-providers.js";
