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
  ensureDir,
  ensureMemoryIndexSchema,
  hashText,
  isFileMissingError,
  listMemoryFiles,
  loadSqliteVecExtension,
  normalizeExtraMemoryPaths,
  parseEmbedding,
  readMemoryFile,
  remapChunkLines,
  requireNodeSqlite,
  resolveMemoryBackendConfig,
  runWithConcurrency,
  statRegularFile,
} from "../../packages/memory-host-sdk/src/engine-storage.js";

export type MemorySource = "memory" | "sessions";

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
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
} from "../../packages/memory-host-sdk/src/engine-storage.js";
