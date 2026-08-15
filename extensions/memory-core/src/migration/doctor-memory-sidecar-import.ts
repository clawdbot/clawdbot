import fsSync from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import {
  CREATE_LEGACY_MEMORY_FTS_MATCH_TABLE_SQL,
  LEGACY_MEMORY_FTS_MATCH_TABLE,
  buildLegacyMemoryFtsCopySql,
  buildLegacyMemoryFtsMatchSql,
} from "./legacy-memory-sidecar-fts.js";

export type LegacyMemorySidecarSource = {
  agentId: string;
  legacyPath: string;
  stateDir: string;
  agentDatabasePath: string;
};

export const LEGACY_MEMORY_SIDECAR_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const LEGACY_MEMORY_SIDECAR_SCHEMA = "legacy_memory_sidecar";
const LEGACY_MEMORY_VECTOR_TABLE = "chunks_vec";
const MEMORY_INDEX_META_KEY = "memory_index_meta_v1";

const LEGACY_MEMORY_SOURCE_COLUMNS = ["path", "source", "hash", "mtime", "size"] as const;
const LEGACY_MEMORY_CHUNK_COLUMNS = [
  "id",
  "path",
  "source",
  "start_line",
  "end_line",
  "hash",
  "model",
  "text",
  "embedding",
  "updated_at",
] as const;
const LEGACY_MEMORY_CACHE_COLUMNS = [
  "provider",
  "model",
  "provider_key",
  "hash",
  "embedding",
  "dims",
  "updated_at",
] as const;

type LegacyMemorySidecarImportResult = {
  imported: boolean;
  reason?: "missing-sidecar" | "legacy-schema-missing";
  sources: number;
  chunks: number;
  cacheEntries: number;
  vectorEntries: number | undefined;
  vectorEntriesImported: boolean;
};

export class LegacyMemoryDerivedRowsConflictError extends Error {
  constructor(readonly tableName: string) {
    super(`legacy memory ${tableName} rows conflict with canonical memory index rows`);
  }
}

function tableExists(db: DatabaseSync, schema: string, tableName: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE name = ?`).get(tableName));
}

function tableColumns(db: DatabaseSync, tableName: string, schema = "main"): Set<string> {
  const rows = db.prepare(`PRAGMA ${schema}.table_info(${tableName})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

function tableHasColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
  schema = "main",
  exact = false,
): boolean {
  const columns = tableColumns(db, tableName, schema);
  return (
    (!exact || columns.size === expected.length) && expected.every((column) => columns.has(column))
  );
}

function hasLegacyMemoryIndexTables(db: DatabaseSync, schema = "main"): boolean {
  return (
    tableHasColumns(db, "meta", ["key", "value"], schema, true) &&
    tableHasColumns(db, "files", LEGACY_MEMORY_SOURCE_COLUMNS, schema, true) &&
    tableHasColumns(db, "chunks", LEGACY_MEMORY_CHUNK_COLUMNS, schema, true)
  );
}

function hasLegacyEmbeddingCacheTable(db: DatabaseSync, schema = "main"): boolean {
  return tableHasColumns(db, "embedding_cache", LEGACY_MEMORY_CACHE_COLUMNS, schema, true);
}

function hasLegacyVectorTable(db: DatabaseSync, schema = "main"): boolean {
  return tableHasColumns(db, LEGACY_MEMORY_VECTOR_TABLE, ["id", "embedding"], schema);
}

function tableRowCount(db: DatabaseSync, schema: string, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${schema}.${tableName}`).get() as
    | { count?: unknown }
    | undefined;
  return Number(row?.count ?? 0);
}

function readLegacySidecarCounts(
  db: DatabaseSync,
  schema: string,
  options: { copyVectorRows: boolean },
): Pick<LegacyMemorySidecarImportResult, "sources" | "chunks" | "cacheEntries" | "vectorEntries"> {
  const vectorEntries = readLegacyVectorEntries(db, schema, !options.copyVectorRows);
  return {
    sources: tableRowCount(db, schema, "files"),
    chunks: tableRowCount(db, schema, "chunks"),
    cacheEntries: hasLegacyEmbeddingCacheTable(db, schema)
      ? tableRowCount(db, schema, "embedding_cache")
      : 0,
    vectorEntries,
  };
}

function readLegacyVectorEntries(
  db: DatabaseSync,
  schema: string,
  tolerateInvalid: boolean,
): number | undefined {
  if (!tableExists(db, schema, LEGACY_MEMORY_VECTOR_TABLE)) {
    return 0;
  }
  try {
    return hasLegacyVectorTable(db, schema)
      ? tableRowCount(db, schema, LEGACY_MEMORY_VECTOR_TABLE)
      : undefined;
  } catch (error) {
    if (!tolerateInvalid) {
      throw error;
    }
    return undefined;
  }
}

function assertLegacyDerivedRowsCopied(db: DatabaseSync, query: string, tableName: string): void {
  const row = db.prepare(query).get() as { missing?: unknown } | undefined;
  if (Number(row?.missing ?? 0) > 0) {
    throw new LegacyMemoryDerivedRowsConflictError(tableName);
  }
}

function assertLegacyVectorRowsReferenceChunks(db: DatabaseSync, schema: string): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS missing
       FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk
         WHERE chunk.id = legacy.id
       )`,
    )
    .get() as { missing?: unknown } | undefined;
  if (Number(row?.missing ?? 0) > 0) {
    throw new Error(`legacy memory ${LEGACY_MEMORY_VECTOR_TABLE} rows reference missing chunks`);
  }
}

function readMemoryIndexMetaVectorDimensions(
  db: DatabaseSync,
  schema: string,
  tableName: string,
): number | undefined {
  if (!tableExists(db, schema, tableName)) {
    return undefined;
  }
  const meta = db
    .prepare(`SELECT value FROM ${schema}.${tableName} WHERE key = ?`)
    .get(MEMORY_INDEX_META_KEY) as { value?: unknown } | undefined;
  if (typeof meta?.value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(meta.value) as { vectorDims?: unknown };
    const dimensions = Number(parsed.vectorDims);
    return Number.isSafeInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
  } catch {}
  return undefined;
}

function readVectorTableSqlDimensions(
  db: DatabaseSync,
  schema: string,
  tableName: string,
): number | undefined {
  const row = db
    .prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE name = ?`)
    .get(tableName) as { sql?: unknown } | undefined;
  if (typeof row?.sql !== "string") {
    return undefined;
  }
  const match = /embedding\s+FLOAT\[(\d+)\]/i.exec(row.sql);
  const dimensions = Number(match?.[1] ?? 0);
  return Number.isSafeInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
}

function readLegacyVectorDimensions(db: DatabaseSync, schema: string): number | undefined {
  const configuredDimensions =
    readMemoryIndexMetaVectorDimensions(db, schema, "meta") ??
    readVectorTableSqlDimensions(db, schema, LEGACY_MEMORY_VECTOR_TABLE);
  if (configuredDimensions) {
    return configuredDimensions;
  }
  const row = db
    .prepare(
      `SELECT length(embedding) AS bytes FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} WHERE embedding IS NOT NULL LIMIT 1`,
    )
    .get() as { bytes?: unknown } | undefined;
  const bytes = Number(row?.bytes ?? 0);
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes % Float32Array.BYTES_PER_ELEMENT === 0
    ? bytes / Float32Array.BYTES_PER_ELEMENT
    : undefined;
}

function readCanonicalVectorDimensions(db: DatabaseSync): number | undefined {
  return (
    readVectorTableSqlDimensions(db, "main", MEMORY_INDEX_VECTOR_TABLE) ??
    readMemoryIndexMetaVectorDimensions(db, "main", MEMORY_INDEX_META_TABLE)
  );
}

function ensureCanonicalVectorTableForLegacyRows(db: DatabaseSync, schema: string): void {
  if (
    !hasLegacyVectorTable(db, schema) ||
    tableRowCount(db, schema, LEGACY_MEMORY_VECTOR_TABLE) === 0
  ) {
    return;
  }
  const dimensions = readLegacyVectorDimensions(db, schema);
  if (!dimensions) {
    throw new Error("legacy memory chunks_vec rows require vector dimensions before import");
  }
  if (tableExists(db, "main", MEMORY_INDEX_VECTOR_TABLE)) {
    const canonicalDimensions = readCanonicalVectorDimensions(db);
    if (!canonicalDimensions) {
      throw new Error(
        "canonical memory chunks_vec table requires vector dimensions before legacy import",
      );
    }
    if (canonicalDimensions !== dimensions) {
      throw new Error(
        `legacy memory chunks_vec dimensions ${dimensions} do not match canonical memory chunks_vec dimensions ${canonicalDimensions}`,
      );
    }
    return;
  }
  const canonicalMetaDimensions = readMemoryIndexMetaVectorDimensions(
    db,
    "main",
    MEMORY_INDEX_META_TABLE,
  );
  if (canonicalMetaDimensions && canonicalMetaDimensions !== dimensions) {
    throw new Error(
      `legacy memory chunks_vec dimensions ${dimensions} do not match canonical memory chunks_vec dimensions ${canonicalMetaDimensions}`,
    );
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS main.${MEMORY_INDEX_VECTOR_TABLE} USING vec0(\n` +
      `  id TEXT PRIMARY KEY,\n` +
      `  embedding FLOAT[${dimensions}]\n` +
      `)`,
  );
}

function copyLegacyMemoryVectorRows(db: DatabaseSync, schema: string): void {
  if (!hasLegacyVectorTable(db, schema)) {
    return;
  }
  ensureCanonicalVectorTableForLegacyRows(db, schema);
  if (!tableExists(db, "main", MEMORY_INDEX_VECTOR_TABLE)) {
    return;
  }
  assertLegacyVectorRowsReferenceChunks(db, schema);
  assertLegacyDerivedRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
     JOIN main.${MEMORY_INDEX_VECTOR_TABLE} AS canonical ON canonical.id = legacy.id
     WHERE canonical.embedding IS NOT legacy.embedding`,
    LEGACY_MEMORY_VECTOR_TABLE,
  );
  db.exec(`
    INSERT OR IGNORE INTO main.${MEMORY_INDEX_VECTOR_TABLE} (id, embedding)
    SELECT legacy.id, legacy.embedding
    FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
    JOIN main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk ON chunk.id = legacy.id
    WHERE NOT EXISTS (
      SELECT 1 FROM main.${MEMORY_INDEX_VECTOR_TABLE} AS canonical
      WHERE canonical.id = legacy.id
    );
  `);
  assertLegacyDerivedRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.${LEGACY_MEMORY_VECTOR_TABLE} AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_VECTOR_TABLE} AS canonical
       WHERE canonical.id = legacy.id
         AND canonical.embedding IS legacy.embedding
     )`,
    LEGACY_MEMORY_VECTOR_TABLE,
  );
}

function copyLegacyMemoryFtsRows(db: DatabaseSync, schema: string): void {
  if (!tableExists(db, "main", MEMORY_INDEX_FTS_TABLE)) {
    return;
  }
  if (!db.prepare(`SELECT 1 FROM ${schema}.chunks LIMIT 1`).get()) {
    return;
  }
  db.exec(CREATE_LEGACY_MEMORY_FTS_MATCH_TABLE_SQL);
  try {
    db.exec(buildLegacyMemoryFtsMatchSql(schema));
    assertLegacyDerivedRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM temp.${LEGACY_MEMORY_FTS_MATCH_TABLE}
       WHERE exact = 0`,
      "fts",
    );
    db.exec(buildLegacyMemoryFtsCopySql(schema));
  } finally {
    db.exec(`DROP TABLE temp.${LEGACY_MEMORY_FTS_MATCH_TABLE}`);
  }
}

function copyLegacyMemoryIndexRows(
  db: DatabaseSync,
  schema: string,
  options: { copyVectorRows: boolean },
): void {
  db.exec(`
    INSERT OR IGNORE INTO main.${MEMORY_INDEX_META_TABLE} (key, value)
    SELECT key, value FROM ${schema}.meta;

    INSERT OR IGNORE INTO main.${MEMORY_INDEX_SOURCES_TABLE} (path, source, hash, mtime, size)
    SELECT path, source, hash, mtime, size FROM ${schema}.files;

    INSERT OR IGNORE INTO main.${MEMORY_INDEX_CHUNKS_TABLE} (
      id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
    )
    SELECT id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
    FROM ${schema}.chunks;
  `);
  assertLegacyDerivedRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.meta AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_META_TABLE} AS canonical
       WHERE canonical.key = legacy.key AND canonical.value IS legacy.value
     )`,
    "meta",
  );
  assertLegacyDerivedRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.files AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_SOURCES_TABLE} AS canonical
       WHERE canonical.path = legacy.path
         AND canonical.source IS legacy.source
         AND canonical.hash IS legacy.hash
         AND canonical.mtime IS legacy.mtime
         AND canonical.size IS legacy.size
     )`,
    "files",
  );
  assertLegacyDerivedRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.chunks AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS canonical
       WHERE canonical.id = legacy.id
         AND canonical.path IS legacy.path
         AND canonical.source IS legacy.source
         AND canonical.start_line IS legacy.start_line
         AND canonical.end_line IS legacy.end_line
         AND canonical.hash IS legacy.hash
         AND canonical.model IS legacy.model
         AND canonical.text IS legacy.text
         AND canonical.embedding IS legacy.embedding
         AND canonical.updated_at IS legacy.updated_at
     )`,
    "chunks",
  );
  copyLegacyMemoryFtsRows(db, schema);
  if (options.copyVectorRows) {
    copyLegacyMemoryVectorRows(db, schema);
  }
  if (hasLegacyEmbeddingCacheTable(db, schema)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS main.${MEMORY_EMBEDDING_CACHE_TABLE} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      ) STRICT;
      INSERT OR IGNORE INTO main.${MEMORY_EMBEDDING_CACHE_TABLE} (
        provider, model, provider_key, hash, embedding, dims, updated_at
      )
      SELECT provider, model, provider_key, hash, embedding, dims, updated_at
      FROM ${schema}.embedding_cache;
    `);
    // Matching cache keys are derived rows. Validate shape before deciding whether the
    // entire stale sidecar should yield to the canonical index.
    assertLegacyDerivedRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM ${schema}.embedding_cache AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_EMBEDDING_CACHE_TABLE} AS canonical
         WHERE canonical.provider = legacy.provider
           AND canonical.model = legacy.model
           AND canonical.provider_key = legacy.provider_key
           AND canonical.hash = legacy.hash
           AND canonical.dims IS legacy.dims
           AND CASE WHEN json_valid(canonical.embedding) AND json_valid(legacy.embedding) THEN json_type(canonical.embedding) = 'array' AND json_array_length(canonical.embedding) = canonical.dims AND json_type(legacy.embedding) = 'array' AND json_array_length(legacy.embedding) = legacy.dims ELSE 0 END
       )`,
      "embedding_cache",
    );
  }
}

export function importLegacyMemorySidecarIndex(params: {
  db: DatabaseSync;
  legacySidecarDatabasePath: string | undefined;
  copyVectorRows: boolean;
  requireVectorRows: boolean;
}): LegacyMemorySidecarImportResult {
  if (!params.legacySidecarDatabasePath || !fsSync.existsSync(params.legacySidecarDatabasePath)) {
    return {
      imported: false,
      reason: "missing-sidecar",
      sources: 0,
      chunks: 0,
      cacheEntries: 0,
      vectorEntries: 0,
      vectorEntriesImported: true,
    };
  }
  params.db
    .prepare(`ATTACH DATABASE ? AS ${LEGACY_MEMORY_SIDECAR_SCHEMA}`)
    .run(params.legacySidecarDatabasePath);
  try {
    if (!hasLegacyMemoryIndexTables(params.db, LEGACY_MEMORY_SIDECAR_SCHEMA)) {
      return {
        imported: false,
        reason: "legacy-schema-missing",
        sources: 0,
        chunks: 0,
        cacheEntries: 0,
        vectorEntries: 0,
        vectorEntriesImported: true,
      };
    }
    const counts = readLegacySidecarCounts(params.db, LEGACY_MEMORY_SIDECAR_SCHEMA, {
      copyVectorRows: params.copyVectorRows,
    });
    params.db.exec("SAVEPOINT import_legacy_sidecar_memory_index");
    try {
      copyLegacyMemoryIndexRows(params.db, LEGACY_MEMORY_SIDECAR_SCHEMA, {
        copyVectorRows: params.copyVectorRows,
      });
      params.db.exec("RELEASE import_legacy_sidecar_memory_index");
      return {
        imported: true,
        ...counts,
        vectorEntriesImported:
          counts.vectorEntries === 0 ||
          !params.requireVectorRows ||
          (params.copyVectorRows && counts.vectorEntries !== undefined),
      };
    } catch (err) {
      params.db.exec("ROLLBACK TO import_legacy_sidecar_memory_index");
      params.db.exec("RELEASE import_legacy_sidecar_memory_index");
      throw err;
    }
  } finally {
    params.db.exec(`DETACH DATABASE ${LEGACY_MEMORY_SIDECAR_SCHEMA}`);
  }
}
