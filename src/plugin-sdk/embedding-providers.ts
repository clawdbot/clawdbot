/**
 * Public SDK subpath for embedding provider registration and runtime access.
 */
export {
  getEmbeddingProvider,
  listEmbeddingProviders,
} from "../plugins/embedding-provider-runtime.js";

export type {
  EmbeddingBatchChunk,
  EmbeddingBatchOptions,
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "../plugins/embedding-providers.js";
