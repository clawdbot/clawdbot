// Memory core host embedding exports expose host embedding primitives to the memory plugin.
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
  EmbeddingBatchUnavailableError,
  EMBEDDING_BATCH_ENDPOINT,
  enforceEmbeddingMaxInputTokens,
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
  extractBatchErrorMessage,
  fetchRemoteEmbeddingVectors,
  formatBatchErrorDetail,
  formatUnavailableBatchError,
  getMemoryMultimodalExtensions,
  hasNonTextEmbeddingParts,
  isEmbeddingBatchUnavailableError,
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  normalizeBatchBaseUrl,
  normalizeEmbeddingModelWithPrefixes,
  postJsonWithRetry,
  readEmbeddingBatchJsonl,
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  resolveRemoteEmbeddingBearerClient,
  resolveRemoteEmbeddingClient,
  runEmbeddingBatchGroups,
  sanitizeAndNormalizeEmbedding,
  sanitizeEmbeddingCacheHeaders,
  throwIfBatchCompletionError,
  throwIfBatchTerminalFailure,
  uploadBatchJsonlFile,
  withRemoteHttpResponse,
} from "../../packages/memory-host-sdk/src/engine-embeddings.js";

export type {
  BatchCompletionResult,
  BatchHttpClientConfig,
  EmbeddingBatchExecutionParams,
  EmbeddingBatchStatus,
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
export { clearMemoryEmbeddingProviders } from "../plugins/memory-embedding-providers.js";
/**
 * @deprecated New embedding providers should use `api.registerEmbeddingProvider(...)`
 * and `contracts.embeddingProviders`. This memory-specific registrar remains
 * available only for compatibility while existing providers migrate.
 */
export { registerMemoryEmbeddingProvider } from "../plugins/memory-embedding-providers.js";
export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCallOptions,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderIndexIdentity,
  MemoryEmbeddingProviderRuntime,
} from "../plugins/memory-embedding-providers.js";
