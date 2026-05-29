import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getRuntimeEmbeddingProviderAdapter,
  listRuntimeEmbeddingProviderAdapters,
  readConfiguredProviderApiId,
  resolveRuntimeEmbeddingProviderLookupIds,
} from "./embedding-provider-runtime-shared.js";
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
  return listRuntimeEmbeddingProviderAdapters({
    key: "embeddingProviders",
    cfg,
    registered: listRegisteredEmbeddingProviderAdapters(),
  });
}

function resolveConfiguredEmbeddingProviderId(
  providerId: string,
  cfg?: OpenClawConfig,
): string | undefined {
  return readConfiguredProviderApiId({
    providerId,
    cfg,
    resolveApiProviderId: (normalizedApiId) =>
      OPENAI_COMPATIBLE_MODEL_APIS.has(normalizedApiId)
        ? OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID
        : normalizedApiId,
    resolveMissingApiProviderId: (providerConfig) =>
      providerConfig.baseUrl?.trim() ? OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID : undefined,
  });
}

function resolveEmbeddingProviderLookupIds(id: string, cfg?: OpenClawConfig): string[] {
  return resolveRuntimeEmbeddingProviderLookupIds({
    id,
    cfg,
    resolveConfiguredProviderId: resolveConfiguredEmbeddingProviderId,
  });
}

export function getEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): EmbeddingProviderAdapter | undefined {
  return getRuntimeEmbeddingProviderAdapter({
    key: "embeddingProviders",
    cfg,
    lookupIds: resolveEmbeddingProviderLookupIds(id, cfg),
    getRegisteredProvider: getRegisteredEmbeddingProvider,
  });
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
