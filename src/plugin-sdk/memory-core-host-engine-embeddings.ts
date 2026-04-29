export {
  applyEmbeddingBatchOutputLine,
  buildBatchHeaders,
  buildCaseInsensitiveExtensionGlob,
  buildEmbeddingBatchGroupOptions,
  buildRemoteBaseUrlPolicy,
  classifyMemoryMultimodalPath,
  createLocalEmbeddingProvider,
  createRemoteEmbeddingProvider,
  debugEmbeddingsLog,
  DEFAULT_LOCAL_MODEL,
  EMBEDDING_BATCH_ENDPOINT,
  enforceEmbeddingMaxInputTokens,
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
  extractBatchErrorMessage,
  fetchRemoteEmbeddingVectors,
  formatUnavailableBatchError,
  getMemoryMultimodalExtensions,
  hasNonTextEmbeddingParts,
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  normalizeBatchBaseUrl,
  normalizeEmbeddingModelWithPrefixes,
  postJsonWithRetry,
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  resolveRemoteEmbeddingBearerClient,
  resolveRemoteEmbeddingClient,
  runEmbeddingBatchGroups,
  sanitizeAndNormalizeEmbedding,
  sanitizeEmbeddingCacheHeaders,
  throwIfBatchTerminalFailure,
  uploadBatchJsonlFile,
  withRemoteHttpResponse,
} from "../../packages/memory-host-sdk/src/engine-embeddings.js";

export type EmbeddingBatchStatus = {
  id?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
};

export type {
  BatchCompletionResult,
  BatchHttpClientConfig,
  EmbeddingBatchExecutionParams,
  EmbeddingInput,
  ProviderBatchOutputLine,
  RemoteEmbeddingClient,
  RemoteEmbeddingProviderId,
} from "../../packages/memory-host-sdk/src/engine-embeddings.js";
export {
  getMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviderAdapters,
  listRegisteredMemoryEmbeddingProviders,
} from "../plugins/memory-embedding-provider-runtime.js";
export {
  clearMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "../plugins/memory-embedding-providers.js";
export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderRuntime,
} from "../plugins/memory-embedding-providers.js";
