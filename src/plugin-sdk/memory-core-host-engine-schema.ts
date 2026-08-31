// Focused memory host schema helpers for doctor and migration control-plane paths.
export {
  ensureMemoryIndexSchema,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
} from "../../packages/memory-host-sdk/src/host/memory-schema.js";
export { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/host/sqlite-vec.js";
