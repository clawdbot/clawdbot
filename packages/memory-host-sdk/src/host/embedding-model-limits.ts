import type { EmbeddingProvider } from "./embeddings.types.js";

// Provider input limits are byte-based approximations for pre-embedding chunk splitting.

const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8192;
const DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS = 2048;
// Conservative floor for remote embeddings endpoints that cap the input array
// (Zhipu embedding models allow 64 texts per request; OpenAI documents 2048).
const DEFAULT_EMBEDDING_MAX_INPUTS_PER_REQUEST = 64;

/** Resolve the effective embedding input limit for a provider. */
export function resolveEmbeddingMaxInputTokens(provider: EmbeddingProvider): number {
  if (typeof provider.maxInputTokens === "number") {
    return provider.maxInputTokens;
  }

  if (provider.id === "local") {
    return DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS;
  }

  return DEFAULT_EMBEDDING_MAX_INPUT_TOKENS;
}

/** Resolve the effective per-request input-item cap for a provider. */
export function resolveEmbeddingMaxInputsPerRequest(provider: EmbeddingProvider): number {
  if (typeof provider.maxInputsPerRequest === "number" && provider.maxInputsPerRequest > 0) {
    return provider.maxInputsPerRequest;
  }
  return DEFAULT_EMBEDDING_MAX_INPUTS_PER_REQUEST;
}
