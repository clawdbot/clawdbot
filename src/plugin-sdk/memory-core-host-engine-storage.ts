/**
 * Public SDK subpath for memory host storage, indexing, and search primitives.
 */
export {
  buildFileEntry,
  buildMemoryReadResult,
  buildMemoryReadResultFromSlice,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  cosineSimilarity,
  DEFAULT_MEMORY_READ_LINES,
  DEFAULT_MEMORY_READ_MAX_CHARS,
  dropMemoryPathFtsTriggers,
  ensureDir,
  ensureMemoryIndexSchema,
  ensureMemoryPathFtsTriggers,
  hashText,
  isFileMissingError,
  isTransientMemoryReadError,
  listMemoryFiles,
  loadSqliteVecExtension,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_STATE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  normalizeExtraMemoryPaths,
  parseEmbedding,
  readMemoryFile,
  retryTransientMemoryRead,
  remapChunkLines,
  requireNodeSqlite,
  resolveMemoryBackendConfig,
  runWithConcurrency,
  statRegularFile,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

/** Origin bucket for memory search results exposed through the SDK. */
export type MemorySource = "memory" | "sessions";

/** Normalized search hit shape returned by memory host searches. */
export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

/** Health probe result for embedding provider availability checks. */
export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};

export type {
  MemoryChunk,
  MemoryFileEntry,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySyncProgressUpdate,
  MemorySessionSyncTarget,
  MemorySyncParams,
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
} from "../../packages/memory-host-sdk/src/engine-storage.js";
