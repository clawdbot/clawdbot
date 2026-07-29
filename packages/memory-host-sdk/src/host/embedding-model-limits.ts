// Memory Host SDK module implements embedding model limits behavior.
import type { EmbeddingProvider } from "./embeddings.js";

// Provider input limits are byte-based approximations for pre-embedding chunk splitting.

const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8192;
const DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS = 2048;

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
