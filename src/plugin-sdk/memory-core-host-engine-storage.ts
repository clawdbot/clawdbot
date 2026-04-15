// Compat barrel: memory-core-host-engine-storage
// Maps the memory-core extension's storage/DB layer to internal src/memory/* modules.

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
  type MemorySource,
  type MemorySyncProgressUpdate,
} from "../memory/internal.js";

export { isFileMissingError, statRegularFile } from "../memory/fs-utils.js";
export { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
export { loadSqliteVecExtension } from "../memory/sqlite-vec.js";
export { requireNodeSqlite } from "../memory/sqlite.js";
export { resolveMemoryBackendConfig } from "../memory/backend-config.js";

export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "../memory/types.js";

// MemorySearchRuntimeDebug and readMemoryFile are already in the runtime-files subpath barrel.
// Re-export them here too so callers that import from engine-storage get them.
export { readAgentMemoryFile as readMemoryFile, type MemorySearchRuntimeDebug } from "./memory-core-host-runtime-files.js";

// normalizeLowercaseStringOrEmpty is re-exported for convenience (consumers may import it from here).
export { normalizeOptionalString as normalizeLowercaseStringOrEmpty } from "./text-runtime.js";
