import type { EmbeddingProvider } from "./embeddings.js";

const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8192;
const DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS = 2048;

export function resolveEmbeddingMaxInputTokens(provider: EmbeddingProvider): number {
  if (typeof provider.maxInputTokens === "number") {
    return provider.maxInputTokens;
  }

  if (provider.id === "local") {
    return DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS;
  }

  return DEFAULT_EMBEDDING_MAX_INPUT_TOKENS;
}
