// Memory Host SDK module implements memory schema behavior.
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";
import {
  dropDisabledMemoryChunkFts,
  dropMemoryPathFtsTriggers,
  ensureMemoryPathFtsSchema,
  ensureMemoryPathFtsTriggers,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  rebuildMemoryChunkFts,
} from "./memory-schema-fts.js";
import {
  assertLegacyMemoryRowsCopied,
  ensureLegacyMemoryMigrationIndexes,
} from "./memory-schema-migration.js";
import { migrateSqliteSchemaToStrict } from "./openclaw-runtime-sqlite.js";

export {
  dropMemoryPathFtsTriggers,
  ensureMemoryPathFtsTriggers,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
} from "./memory-schema-fts.js";

// SQLite schema setup for builtin memory index, embedding cache, and FTS.

export const MEMORY_INDEX_META_TABLE = "memory_index_meta";
export const MEMORY_EMBEDDING_CACHE_TABLE = "memory_embedding_cache";
export const MEMORY_INDEX_STATE_TABLE = "memory_index_state";
export const MEMORY_INDEX_VECTOR_TABLE = "memory_index_chunks_vec";

const LEGACY_MEMORY_INDEX_TRIGGERS = [
  "memory_files_revision_after_insert",
  "memory_files_revision_after_update",
  "memory_files_revision_after_delete",
  "memory_chunks_revision_after_insert",
  "memory_chunks_revision_after_update",
  "memory_chunks_revision_after_delete",
] as const;

const LEGACY_MEMORY_INDEX_SOURCE_COLUMNS = ["path", "source", "hash", "mtime", "size"] as const;
const MEMORY_INDEX_SOURCE_COLUMNS = ["id", ...LEGACY_MEMORY_INDEX_SOURCE_COLUMNS] as const;
const MEMORY_INDEX_SOURCE_COLUMN_TYPES = new Map<string, string>([
  ["id", "INTEGER"],
  ["path", "TEXT"],
  ["source", "TEXT"],
  ["hash", "TEXT"],
  ["mtime", "REAL"],
  ["size", "INTEGER"],
]);

type TableColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  defaultValue: string | null;
  hidden: number;
};

function tableColumnInfo(db: DatabaseSync, tableName: string, schema = "main"): TableColumnInfo[] {
  const rows = db.prepare(`PRAGMA ${schema}.table_xinfo(${tableName})`).all() as Array<{
    name?: unknown;
    type?: unknown;
    notnull?: unknown;
    pk?: unknown;
    dflt_value?: unknown;
    hidden?: unknown;
  }>;
  return rows.flatMap((row) =>
    typeof row.name === "string" && typeof row.type === "string"
      ? [
          {
            name: row.name,
            type: row.type.toUpperCase(),
            notnull: Number(row.notnull ?? 0),
            pk: Number(row.pk ?? 0),
            defaultValue: typeof row.dflt_value === "string" ? row.dflt_value : null,
            hidden: Number(row.hidden ?? 0),
          },
        ]
      : [],
  );
}

function tableColumns(db: DatabaseSync, tableName: string, schema = "main"): Set<string> {
  return new Set(tableColumnInfo(db, tableName, schema).map((row) => row.name));
}

function tableHasExactColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
  schema = "main",
): boolean {
  const columns = tableColumns(db, tableName, schema);
  return columns.size === expected.length && expected.every((column) => columns.has(column));
}

function tablePrimaryKeyColumns(db: DatabaseSync, tableName: string): string[] {
  return tableColumnInfo(db, tableName)
    .filter((row) => row.pk > 0)
    .toSorted((left, right) => left.pk - right.pk)
    .map((row) => row.name);
}

function tableHasPrimaryKey(
  db: DatabaseSync,
  tableName: string,
  expectedColumns: readonly string[],
): boolean {
  const columns = tablePrimaryKeyColumns(db, tableName);
  return (
    columns.length === expectedColumns.length &&
    columns.every((column, index) => column === expectedColumns[index])
  );
}

function tableHasUniqueIndex(
  db: DatabaseSync,
  tableName: string,
  expectedColumns: readonly string[],
): boolean {
  const indexes = db
    .prepare(`SELECT name, partial FROM pragma_index_list(?) WHERE "unique" = 1`)
    .all(tableName) as Array<{ name?: unknown; partial?: unknown }>;
  if (indexes.length !== 1) {
    return false;
  }
  return indexes.some((index) => {
    if (typeof index.name !== "string" || Number(index.partial ?? 0) !== 0) {
      return false;
    }
    const columns = db
      .prepare(
        `SELECT cid, name, coll, "desc" AS sort_desc, key FROM pragma_index_xinfo(?) ORDER BY seqno`,
      )
      .all(index.name)
      .filter((row) => Number((row as { key?: unknown }).key ?? 0) === 1) as Array<{
      cid?: unknown;
      name?: unknown;
      coll?: unknown;
      sort_desc?: unknown;
    }>;
    return (
      columns.length === expectedColumns.length &&
      columns.every(
        (column, columnIndex) =>
          Number(column.cid ?? -1) >= 0 &&
          column.name === expectedColumns[columnIndex] &&
          column.coll === "BINARY" &&
          Number(column.sort_desc ?? 0) === 0,
      )
    );
  });
}

function tableHasNoDeclaredCollations(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`)
    .get(tableName) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" && !/\bCOLLATE\b/iu.test(row.sql);
}

function tableHasCanonicalSourceColumnTypes(db: DatabaseSync): boolean {
  const columns = tableColumnInfo(db, MEMORY_INDEX_SOURCES_TABLE);
  return columns.every((column) => {
    const expectedType = MEMORY_INDEX_SOURCE_COLUMN_TYPES.get(column.name);
    const expectedDefault = column.name === "source" ? "'memory'" : null;
    if (
      (column.type !== expectedType && !(column.name === "mtime" && column.type === "INTEGER")) ||
      column.defaultValue !== expectedDefault ||
      column.hidden !== 0
    ) {
      return false;
    }
    return true;
  });
}

function tableHasCanonicalSourceColumns(db: DatabaseSync): boolean {
  return (
    tableHasCanonicalSourceColumnTypes(db) &&
    tableColumnInfo(db, MEMORY_INDEX_SOURCES_TABLE).every((column) => {
      return column.name === "id" || column.notnull === 1;
    })
  );
}

function tableHasLegacySourceColumns(db: DatabaseSync, hasPathPrimaryKey: boolean): boolean {
  return (
    tableHasCanonicalSourceColumnTypes(db) &&
    tableColumnInfo(db, MEMORY_INDEX_SOURCES_TABLE).every((column) => {
      return (hasPathPrimaryKey && column.name === "path") || column.notnull === 1;
    })
  );
}

function tableHasIntegerRowIdPrimaryKey(db: DatabaseSync): boolean {
  const idColumn = tableColumnInfo(db, MEMORY_INDEX_SOURCES_TABLE).find(
    (column) => column.name === "id",
  );
  if (idColumn?.type !== "INTEGER" || !tableHasPrimaryKey(db, MEMORY_INDEX_SOURCES_TABLE, ["id"])) {
    return false;
  }
  // INTEGER PRIMARY KEY DESC and WITHOUT ROWID tables expose a PK index;
  // neither gives FTS the stable rowid alias this schema requires.
  const primaryKeyIndex = db
    .prepare(`SELECT 1 AS found FROM pragma_index_list(?) WHERE origin = 'pk' LIMIT 1`)
    .get(MEMORY_INDEX_SOURCES_TABLE) as { found?: unknown } | undefined;
  return primaryKeyIndex?.found !== 1;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { found?: unknown } | undefined;
  return row?.found === 1;
}

/** Upgrade canonical memory sources to stable integer identities. */
export function migrateMemoryIndexSourcesIdentity(db: DatabaseSync): void {
  if (!tableExists(db, MEMORY_INDEX_SOURCES_TABLE)) {
    return;
  }
  if (tableHasExactColumns(db, MEMORY_INDEX_SOURCES_TABLE, MEMORY_INDEX_SOURCE_COLUMNS)) {
    if (
      tableHasCanonicalSourceColumns(db) &&
      tableHasIntegerRowIdPrimaryKey(db) &&
      tableHasNoDeclaredCollations(db, MEMORY_INDEX_SOURCES_TABLE) &&
      tableHasUniqueIndex(db, MEMORY_INDEX_SOURCES_TABLE, ["path", "source"])
    ) {
      return;
    }
    throw new Error("canonical memory source identity schema is invalid");
  }
  if (!tableHasExactColumns(db, MEMORY_INDEX_SOURCES_TABLE, LEGACY_MEMORY_INDEX_SOURCE_COLUMNS)) {
    throw new Error("canonical memory source identity schema is invalid");
  }
  const hasPathPrimaryKey = tableHasPrimaryKey(db, MEMORY_INDEX_SOURCES_TABLE, ["path"]);
  const hasPathSourcePrimaryKey = tableHasPrimaryKey(db, MEMORY_INDEX_SOURCES_TABLE, [
    "path",
    "source",
  ]);
  if (!hasPathPrimaryKey && !hasPathSourcePrimaryKey) {
    throw new Error("canonical memory source identity schema is invalid");
  }
  if (!tableHasLegacySourceColumns(db, hasPathPrimaryKey)) {
    throw new Error("canonical memory source identity schema is invalid");
  }

  const rebuildsPathFts = tableExists(db, MEMORY_INDEX_PATHS_FTS_TABLE);
  db.exec("SAVEPOINT migrate_memory_index_sources_identity");
  try {
    dropMemoryPathFtsTriggers(db);
    db.exec(`
      DROP TRIGGER IF EXISTS memory_index_sources_revision_after_insert;
      DROP TRIGGER IF EXISTS memory_index_sources_revision_after_update;
      DROP TRIGGER IF EXISTS memory_index_sources_revision_after_delete;

      ALTER TABLE ${MEMORY_INDEX_SOURCES_TABLE}
        RENAME TO memory_index_sources_identity_migration;
      CREATE TABLE ${MEMORY_INDEX_SOURCES_TABLE} (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime REAL NOT NULL,
        size INTEGER NOT NULL,
        UNIQUE (path, source)
      ) STRICT;
      INSERT INTO ${MEMORY_INDEX_SOURCES_TABLE} (id, path, source, hash, mtime, size)
      SELECT rowid, path, source, hash, mtime, size
      FROM memory_index_sources_identity_migration;
      DROP TABLE memory_index_sources_identity_migration;
    `);
    if (rebuildsPathFts) {
      db.exec(`
        DELETE FROM ${MEMORY_INDEX_PATHS_FTS_TABLE};
        INSERT INTO ${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source)
        SELECT id, path, source FROM ${MEMORY_INDEX_SOURCES_TABLE};
      `);
      ensureMemoryPathFtsTriggers(db);
    }
    db.exec("RELEASE migrate_memory_index_sources_identity");
  } catch (err) {
    db.exec("ROLLBACK TO migrate_memory_index_sources_identity");
    db.exec("RELEASE migrate_memory_index_sources_identity");
    throw err;
  }
}

function hasLegacyMemoryIndexTables(db: DatabaseSync, schema = "main"): boolean {
  return (
    tableHasExactColumns(db, "meta", ["key", "value"], schema) &&
    tableHasExactColumns(db, "files", ["path", "source", "hash", "mtime", "size"], schema) &&
    tableHasExactColumns(
      db,
      "chunks",
      [
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
      ],
      schema,
    )
  );
}

function hasLegacyEmbeddingCacheTable(db: DatabaseSync, schema = "main"): boolean {
  return tableHasExactColumns(
    db,
    "embedding_cache",
    ["provider", "model", "provider_key", "hash", "embedding", "dims", "updated_at"],
    schema,
  );
}

function copyLegacyMemoryIndexRows(
  db: DatabaseSync,
  schema: string,
  preservedEmbeddingCacheTable?: string,
): void {
  ensureLegacyMemoryMigrationIndexes(db, schema);
  // Canonical-owned chunk sets stay intact; any extra legacy identity invalidates
  // the source for rebuild. Chunkless sources import only when metadata matches.
  // Keep invalidated rows for deleted-file cleanup; snapshot before inserts.
  db.exec(`
    CREATE TEMP TABLE legacy_import_chunk_excluded_sources AS
    SELECT DISTINCT owned.path, owned.source,
      CASE WHEN EXISTS (
        SELECT 1 FROM ${schema}.chunks AS legacy_chunk
        WHERE legacy_chunk.path = owned.path AND legacy_chunk.source IS owned.source
          AND NOT EXISTS (
            SELECT 1 FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS canonical_chunk
            WHERE canonical_chunk.id = legacy_chunk.id
              AND canonical_chunk.path IS legacy_chunk.path AND canonical_chunk.source IS legacy_chunk.source
          )
      ) THEN 1 ELSE 0 END AS force_reindex
    FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS owned
    WHERE EXISTS (
      SELECT 1 FROM ${schema}.files AS legacy_file
      WHERE legacy_file.path = owned.path AND legacy_file.source IS owned.source
    )
    UNION ALL
    SELECT canonical.path, canonical.source, 1 AS force_reindex
    FROM main.${MEMORY_INDEX_SOURCES_TABLE} AS canonical
    JOIN ${schema}.files AS legacy
      ON legacy.path = canonical.path AND legacy.source IS canonical.source
    WHERE (
      canonical.hash IS NOT legacy.hash
      OR canonical.mtime IS NOT legacy.mtime
      OR canonical.size IS NOT legacy.size
    )
      AND NOT EXISTS (
        SELECT 1 FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS chunk
        WHERE chunk.path = canonical.path AND chunk.source IS canonical.source
      );

    CREATE TEMP TABLE legacy_import_dirty_sources AS
    SELECT legacy.path, legacy.source
    FROM ${schema}.files AS legacy
    WHERE NOT EXISTS (
      SELECT 1 FROM main.${MEMORY_INDEX_SOURCES_TABLE} AS canonical
      WHERE canonical.path = legacy.path AND canonical.source IS legacy.source
    )
    UNION
    SELECT legacy.path, legacy.source
    FROM ${schema}.chunks AS legacy
    WHERE EXISTS (
      SELECT 1 FROM ${schema}.files AS owner
      WHERE owner.path = legacy.path AND owner.source IS legacy.source
    )
      AND NOT EXISTS (
        SELECT 1 FROM temp.legacy_import_chunk_excluded_sources AS excluded
        WHERE excluded.path = legacy.path AND excluded.source IS legacy.source
      )
      AND NOT EXISTS (
        SELECT 1 FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS canonical
        WHERE canonical.id = legacy.id
      )
    UNION
    SELECT excluded.path, excluded.source
    FROM temp.legacy_import_chunk_excluded_sources AS excluded
    WHERE excluded.force_reindex = 1;
  `);
  try {
    db.exec(`
      INSERT OR IGNORE INTO main.${MEMORY_INDEX_META_TABLE} (key, value)
      SELECT key, value FROM ${schema}.meta;

      INSERT OR IGNORE INTO main.${MEMORY_INDEX_SOURCES_TABLE} (path, source, hash, mtime, size)
      SELECT path, source, hash, mtime, size
      FROM ${schema}.files;

      INSERT OR IGNORE INTO main.${MEMORY_INDEX_CHUNKS_TABLE} (
        id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
      )
      -- Chunks are derived from source rows. Shipped cleanup could leave an
      -- ownerless legacy chunk, which must not become permanently searchable.
      SELECT id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
      FROM ${schema}.chunks AS legacy
      WHERE EXISTS (
        SELECT 1 FROM ${schema}.files AS owner
        WHERE owner.path = legacy.path AND owner.source IS legacy.source
      )
        AND NOT EXISTS (
          SELECT 1 FROM temp.legacy_import_chunk_excluded_sources AS excluded
          WHERE excluded.path = legacy.path AND excluded.source IS legacy.source
        );

      -- Content hashes are SHA-256 hex, so an empty hash cannot match a file.
      -- Imported sources or chunks may be absent from runtime-owned vector
      -- indexes, while excluded sources need a canonical rebuild. Retaining the
      -- dirty source lets sync rebuild every derived row or clean up a deleted file.
      UPDATE main.${MEMORY_INDEX_SOURCES_TABLE}
      SET hash = ''
      WHERE EXISTS (
        SELECT 1 FROM temp.legacy_import_dirty_sources AS dirty
        WHERE dirty.path = main.${MEMORY_INDEX_SOURCES_TABLE}.path
          AND dirty.source IS main.${MEMORY_INDEX_SOURCES_TABLE}.source
      );
    `);
    assertLegacyMemoryRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM ${schema}.meta AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_INDEX_META_TABLE} AS canonical
         WHERE canonical.key = legacy.key
       )`,
      "meta",
    );
    assertLegacyMemoryRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM ${schema}.files AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_INDEX_SOURCES_TABLE} AS canonical
         WHERE canonical.path = legacy.path
           AND canonical.source IS legacy.source
       )
       AND NOT EXISTS (
         SELECT 1 FROM temp.legacy_import_chunk_excluded_sources AS excluded
         WHERE excluded.force_reindex = 1
           AND excluded.path = legacy.path
           AND excluded.source IS legacy.source
       )`,
      "files",
    );
    assertLegacyMemoryRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM ${schema}.chunks AS legacy
       WHERE EXISTS (
         SELECT 1 FROM ${schema}.files AS owner
         WHERE owner.path = legacy.path AND owner.source IS legacy.source
       )
       AND NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS canonical
         WHERE canonical.id = legacy.id
           AND canonical.path IS legacy.path
           AND canonical.source IS legacy.source
       )
       AND NOT EXISTS (
         SELECT 1 FROM temp.legacy_import_chunk_excluded_sources AS excluded
         WHERE excluded.path = legacy.path AND excluded.source IS legacy.source
       )`,
      "chunks",
    );
    // Repair derived orphans only after authoritative copy assertions pass;
    // otherwise a synthetic owner could mask an uncopyable legacy source row.
    db.exec(`
      INSERT OR IGNORE INTO main.${MEMORY_INDEX_SOURCES_TABLE} (path, source, hash, mtime, size)
      SELECT DISTINCT orphan.path, orphan.source, '', 0, 0 FROM main.${MEMORY_INDEX_CHUNKS_TABLE} AS orphan
      WHERE NOT EXISTS (
        SELECT 1 FROM main.${MEMORY_INDEX_SOURCES_TABLE} AS owner
        WHERE owner.path = orphan.path AND owner.source IS orphan.source
      );
    `);
  } finally {
    db.exec("DROP TABLE temp.legacy_import_dirty_sources");
    db.exec("DROP TABLE temp.legacy_import_chunk_excluded_sources");
  }
  if (
    preservedEmbeddingCacheTable !== "embedding_cache" &&
    hasLegacyEmbeddingCacheTable(db, schema)
  ) {
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
    assertLegacyMemoryRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM ${schema}.embedding_cache AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_EMBEDDING_CACHE_TABLE} AS canonical
         WHERE canonical.provider = legacy.provider
           AND canonical.model = legacy.model
           AND canonical.provider_key = legacy.provider_key
           AND canonical.hash = legacy.hash
       )`,
      "embedding_cache",
    );
  }
}

function migrateLegacyMemoryIndexTables(
  db: DatabaseSync,
  preservedEmbeddingCacheTable?: string,
  ftsTable = MEMORY_INDEX_FTS_TABLE,
): void {
  if (!hasLegacyMemoryIndexTables(db)) {
    return;
  }

  db.exec("SAVEPOINT migrate_legacy_memory_index_tables");
  try {
    copyLegacyMemoryIndexRows(db, "main", preservedEmbeddingCacheTable);
    // `chunks_fts` belongs to the legacy schema and is dropped below even when
    // a deprecated caller also supplied that name as its preferred FTS table.
    if (ftsTable !== "chunks_fts" && tableExists(db, ftsTable)) {
      // FTS is derived from canonical chunks. Rebuild inside the migration
      // savepoint so imported rows and removed stale rows publish atomically.
      rebuildMemoryChunkFts(db, ftsTable);
    }
    if (preservedEmbeddingCacheTable !== "embedding_cache" && hasLegacyEmbeddingCacheTable(db)) {
      db.exec("DROP TABLE embedding_cache");
    }
    for (const trigger of LEGACY_MEMORY_INDEX_TRIGGERS) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    db.exec(`
      DROP TABLE IF EXISTS chunks_fts;
      DROP TABLE chunks;
      DROP TABLE files;
      DROP TABLE meta;
      RELEASE migrate_legacy_memory_index_tables;
    `);
  } catch (err) {
    db.exec("ROLLBACK TO migrate_legacy_memory_index_tables");
    db.exec("RELEASE migrate_legacy_memory_index_tables");
    throw err;
  }
}

function buildMemoryIndexStrictSchema(params: {
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
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_STATE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    ) STRICT;
    ${embeddingCacheSql}
  `;
}

/** Ensure canonical memory index tables and the optional FTS table exist. */
export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  /** @deprecated Omit to use the canonical memory cache table. */
  embeddingCacheTable?: string;
  cacheEnabled: boolean;
  /** @deprecated Omit to use the canonical memory FTS table. */
  ftsTable?: string;
  ftsEnabled: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
}): { ftsAvailable: boolean; ftsError?: string } {
  const embeddingCacheTable = params.embeddingCacheTable ?? MEMORY_EMBEDDING_CACHE_TABLE;
  const ftsTable = params.ftsTable ?? MEMORY_INDEX_FTS_TABLE;
  params.db.exec(
    buildMemoryIndexStrictSchema({
      embeddingCacheTable,
      includeEmbeddingCache: params.cacheEnabled,
    }),
  );
  params.db.exec(`
    INSERT OR IGNORE INTO ${MEMORY_INDEX_STATE_TABLE} (id, revision) VALUES (1, 0);
  `);
  migrateMemoryIndexSourcesIdentity(params.db);
  params.db.exec(`

    CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_insert
    AFTER INSERT ON ${MEMORY_INDEX_SOURCES_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_update
    AFTER UPDATE ON ${MEMORY_INDEX_SOURCES_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_sources_revision_after_delete
    AFTER DELETE ON ${MEMORY_INDEX_SOURCES_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_insert
    AFTER INSERT ON ${MEMORY_INDEX_CHUNKS_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_update
    AFTER UPDATE ON ${MEMORY_INDEX_CHUNKS_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_index_chunks_revision_after_delete
    AFTER DELETE ON ${MEMORY_INDEX_CHUNKS_TABLE}
    BEGIN
      UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
    END;

    CREATE INDEX IF NOT EXISTS idx_memory_index_sources_source
      ON ${MEMORY_INDEX_SOURCES_TABLE}(source);
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path_source
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(path, source);
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(path);
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(source);
  `);
  migrateLegacyMemoryIndexTables(params.db, params.embeddingCacheTable, ftsTable);
  dropDisabledMemoryChunkFts(params.db, ftsTable, params.ftsEnabled);
  if (params.cacheEnabled) {
    const updatedAtIndex =
      embeddingCacheTable === MEMORY_EMBEDDING_CACHE_TABLE
        ? "idx_memory_embedding_cache_updated_at"
        : "idx_embedding_cache_updated_at";
    params.db.exec(`
      CREATE INDEX IF NOT EXISTS ${updatedAtIndex}
        ON ${embeddingCacheTable}(updated_at);
    `);
  }
  migrateSqliteSchemaToStrict(
    params.db,
    buildMemoryIndexStrictSchema({
      embeddingCacheTable,
      includeEmbeddingCache: params.cacheEnabled || tableExists(params.db, embeddingCacheTable),
    }),
    { databaseLabel: "memory index" },
  );

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      const tokenizer = params.ftsTokenizer ?? "unicode61";
      const tokenizeClause = tokenizer === "trigram" ? `, tokenize='trigram case_sensitive 0'` : "";
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `${tokenizeClause});`,
      );
      // A migration rebuilds an existing FTS table in its savepoint. If the
      // table is new, this same empty-table bootstrap covers all canonical rows.
      params.db.exec(`
        INSERT INTO ${ftsTable} (
          text, id, path, source, model, start_line, end_line
        )
        SELECT text, id, path, source, model, start_line, end_line
        FROM ${MEMORY_INDEX_CHUNKS_TABLE}
        WHERE NOT EXISTS (SELECT 1 FROM ${ftsTable} LIMIT 1);
      `);
      // Deprecated custom FTS tables preserve their body-only contract. The
      // canonical index owns the separate path table and its source triggers.
      if (ftsTable === MEMORY_INDEX_FTS_TABLE) {
        ensureMemoryPathFtsSchema({ db: params.db, tokenizeClause });
      }
      ftsAvailable = true;
    } catch (err) {
      const message = formatErrorMessage(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}
