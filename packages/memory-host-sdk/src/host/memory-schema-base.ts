import {
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
} from "./memory-schema-fts.js";
import {
  MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
} from "./memory-schema-provenance.js";
import {
  MEMORY_INDEX_CHUNK_RECALL_METADATA_SCHEMA_SQL,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
} from "./memory-schema-recall.js";

export const MEMORY_INDEX_META_TABLE = "memory_index_meta";
export const MEMORY_EMBEDDING_CACHE_TABLE = "memory_embedding_cache";
export const MEMORY_INDEX_STATE_TABLE = "memory_index_state";
export const MEMORY_INDEX_VECTOR_TABLE = "memory_index_chunks_vec";

// Only rebuildable index state belongs here, in child-before-parent drop order.
// Origins, tombstones, and canonical sessions are durable owners, not index data.
export const MEMORY_INDEX_DERIVED_TABLES = [
  MEMORY_INDEX_VECTOR_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_STATE_TABLE,
] as const;

export function buildMemoryIndexStrictSchema(params: {
  embeddingCacheTable: string;
  includeEmbeddingCache: boolean;
}): string {
  const embeddingCacheSql = params.includeEmbeddingCache
    ? `
      CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      ) STRICT;
    `
    : "";
  return `
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_SOURCES_TABLE} (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      UNIQUE (path, source)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_CHUNKS_TABLE} (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    ${MEMORY_INDEX_CHUNK_RECALL_METADATA_SCHEMA_SQL}
    ${MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL}
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_STATE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    ) STRICT;
    ${embeddingCacheSql}
  `;
}
