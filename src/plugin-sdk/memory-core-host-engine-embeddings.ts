// Memory core host embedding exports expose host embedding primitives to the memory plugin.

/**
 * @deprecated Load-only bridge for published llama.cpp provider releases from before the
 * managed llama-server cutover. Remove after managed releases have replaced the old npm
 * latest and extended-stable packages and their upgrade window has closed.
 */
export function createLocalEmbeddingProvider(..._args: unknown[]): Promise<never> {
  return Promise.reject(
    new Error(
      "The legacy in-process llama.cpp embedding runtime is retired. Run `openclaw update repair` to install the managed llama-server provider, then restart OpenClaw.",
    ),
  );
}

export {
  applyEmbeddingBatchOutputLine,
  buildBatchHeaders,
  buildCaseInsensitiveExtensionGlob,
  buildEmbeddingBatchGroupOptions,
  buildRemoteBaseUrlPolicy,
  classifyMemoryMultimodalPath,
  createRemoteEmbeddingProvider,
  debugEmbeddingsLog,
  embeddingProviderOwnsDestination,
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
  resolveEmbeddingEndpointUrl,
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  resolveRemoteEmbeddingBearerClient,
  resolveRemoteEmbeddingClient,
  runEmbeddingBatchGroups,
  runEmbeddingBatches,
  sanitizeAndNormalizeEmbedding,
  sanitizeEmbeddingCacheHeaders,
  throwIfBatchCompletionError,
  throwIfBatchTerminalFailure,
  waitForEmbeddingBatch,
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
} from "../plugins/memory-embedding-provider-runtime.js";
export { registerRuntimeAuthProfileStoreMutationListener } from "../agents/auth-profiles/runtime-snapshots.js";
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
