/**
 * Core-facing facade for memory backend storage and index schema helpers. Keep
 * this path stable while the shared SDK package owns their implementations.
 */
export {
  ensureMemoryRecallMetadataColumns,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  resolveMemoryBackendConfig,
  type MemoryProviderStatus,
} from "../../packages/memory-host-sdk/src/engine-storage.js";
