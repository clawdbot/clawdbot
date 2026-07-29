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
  extractProjectKeysFromCuratedEntry,
  DEFAULT_MEMORY_READ_LINES,
  DEFAULT_MEMORY_READ_MAX_CHARS,
  dropMemoryPathFtsTriggers,
  ensureDir,
  ensureMemoryChunkProvenance,
  ensureMemoryIndexSchema,
  ensureMemoryRecallMetadataColumns,
  ensureMemoryPathFtsTriggers,
  hashText,
  INVALID_PROJECT_ANNOTATION_KEY,
  isFileMissingError,
  isTransientMemoryReadError,
  listMemoryFiles,
  loadSqliteVecExtension,
  MEMORY_CHUNKING_VERSION,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_STATE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  normalizeProjectAnnotationKey,
  normalizeExtraMemoryPaths,
  parseEmbedding,
  readMemoryFile,
  readCuratedProjectMemoryCandidates,
  readCuratedMemoryTriggerCandidates,
  readMemoryRecallMetadata,
  retryTransientMemoryRead,
  remapChunkLines,
  requireNodeSqlite,
  resolveMemoryBackendConfig,
  runWithConcurrency,
  splitCuratedMarkdownEntries,
  statRegularFile,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

export type {
  CuratedMarkdownEntry,
  CuratedProjectAnnotations,
  MemoryEntryProvenance,
  MemoryOriginClass,
  MemorySearchResult,
  MemorySessionKind,
  MemorySource,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

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
