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
export { extractBatchErrorMessage, formatUnavailableBatchError } from "./host/batch-error-utils.js";
export { postJsonWithRetry } from "./host/batch-http.js";
export { applyEmbeddingBatchOutputLine } from "./host/batch-output.js";
export {
  EMBEDDING_BATCH_ENDPOINT,
  type EmbeddingBatchStatus,
  type ProviderBatchOutputLine,
} from "./host/batch-provider-common.js";
export {
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
  type EmbeddingBatchExecutionParams,
} from "./host/batch-runner.js";
export {
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  throwIfBatchTerminalFailure,
  type BatchCompletionResult,
} from "./host/batch-status.js";
export { uploadBatchJsonlFile } from "./host/batch-upload.js";
export {
  buildBatchHeaders,
  normalizeBatchBaseUrl,
  type BatchHttpClientConfig,
} from "./host/batch-utils.js";
export { enforceEmbeddingMaxInputTokens } from "./host/embedding-chunk-limits.js";
export {
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
} from "./host/embedding-provider-adapter-utils.js";
export { sanitizeAndNormalizeEmbedding } from "./host/embedding-vectors.js";
export { debugEmbeddingsLog } from "./host/embeddings-debug.js";
export { normalizeEmbeddingModelWithPrefixes } from "./host/embeddings-model-normalize.js";
export {
  resolveRemoteEmbeddingBearerClient,
  type RemoteEmbeddingProviderId,
} from "./host/embeddings-remote-client.js";
export {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
  type RemoteEmbeddingClient,
} from "./host/embeddings-remote-provider.js";
export { fetchRemoteEmbeddingVectors } from "./host/embeddings-remote-fetch.js";
export {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
} from "./host/embedding-input-limits.js";
export { hasNonTextEmbeddingParts, type EmbeddingInput } from "./host/embedding-inputs.js";
export { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./host/remote-http.js";
export {
  buildCaseInsensitiveExtensionGlob,
  classifyMemoryMultimodalPath,
  getMemoryMultimodalExtensions,
} from "./host/multimodal.js";
