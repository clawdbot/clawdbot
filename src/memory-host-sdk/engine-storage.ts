// Real workspace contract for memory engine storage/index helpers.

export {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  cosineSimilarity,
  ensureDir,
  hashText,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  parseEmbedding,
  remapChunkLines,
  runWithConcurrency,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./host/internal.js";
export { readMemoryFile } from "./host/read-file.js";
export {
  buildMemoryReadResult,
  buildMemoryReadResultFromSlice,
  DEFAULT_MEMORY_READ_LINES,
  DEFAULT_MEMORY_READ_MAX_CHARS,
  type MemoryReadResult,
} from "./host/read-file-shared.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export type {
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
} from "./host/backend-config.js";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./host/types.js";
export { ensureMemoryIndexSchema } from "./host/memory-schema.js";
export { loadSqliteVecExtension } from "./host/sqlite-vec.js";
export { requireNodeSqlite } from "./host/sqlite.js";
export { isFileMissingError, statRegularFile } from "./host/fs-utils.js";
