// Real workspace contract for memory embedding providers and batch helpers.

export {
  getMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviderAdapters,
} from "../plugins/memory-embedding-provider-runtime.js";
export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderRuntime,
} from "../plugins/memory-embedding-providers.js";
export { createLocalEmbeddingProvider, DEFAULT_LOCAL_MODEL } from "./host/embeddings.js";
export {
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  buildGeminiEmbeddingRequest,
} from "./host/embeddings-gemini.js";
export {
  createLmstudioEmbeddingProvider,
  DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
} from "./host/embeddings-lmstudio.js";
export type { LmstudioEmbeddingClient } from "./host/embeddings-lmstudio.js";
export {
  createMistralEmbeddingProvider,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
} from "./host/embeddings-mistral.js";
export {
  createOllamaEmbeddingProvider,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
} from "./host/embeddings-ollama.js";
export type { OllamaEmbeddingClient } from "./host/embeddings-ollama.js";
export {
  createOpenAiEmbeddingProvider,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from "./host/embeddings-openai.js";
export {
  createVoyageEmbeddingProvider,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
} from "./host/embeddings-voyage.js";
export { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "./host/batch-gemini.js";
export {
  OPENAI_BATCH_ENDPOINT,
  runOpenAiEmbeddingBatches,
  type OpenAiBatchRequest,
} from "./host/batch-openai.js";
export { runVoyageEmbeddingBatches, type VoyageBatchRequest } from "./host/batch-voyage.js";
export { enforceEmbeddingMaxInputTokens } from "./host/embedding-chunk-limits.js";
export {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
} from "./host/embedding-input-limits.js";
export { hasNonTextEmbeddingParts, type EmbeddingInput } from "./host/embedding-inputs.js";
export {
  buildCaseInsensitiveExtensionGlob,
  classifyMemoryMultimodalPath,
  getMemoryMultimodalExtensions,
} from "./host/multimodal.js";
