// Memory Host SDK module implements memory schema behavior.
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";

// SQLite schema setup for builtin memory index, embedding cache, and FTS.

export const MEMORY_INDEX_META_TABLE = "memory_index_meta";
export const MEMORY_INDEX_SOURCES_TABLE = "memory_index_sources";
export const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";
export const MEMORY_EMBEDDING_CACHE_TABLE = "memory_embedding_cache";
export const MEMORY_INDEX_STATE_TABLE = "memory_index_state";
export const MEMORY_INDEX_FTS_TABLE = "memory_index_chunks_fts";
export const MEMORY_INDEX_PATHS_FTS_TABLE = "memory_index_paths_fts";
export const MEMORY_INDEX_VECTOR_TABLE = "memory_index_chunks_vec";

/** Optional canonical triggers owned by the derived path FTS index. */
export const MEMORY_PATH_FTS_TRIGGER_DEFINITIONS = [
  {
    name: "memory_index_paths_fts_after_insert",
    sql: `
      CREATE TRIGGER IF NOT EXISTS main.memory_index_paths_fts_after_insert
      AFTER INSERT ON ${MEMORY_INDEX_SOURCES_TABLE}
      BEGIN
        INSERT INTO ${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source)
        VALUES (NEW.id, NEW.path, NEW.source);
      END;
    `,
  },
  {
    name: "memory_index_paths_fts_after_update",
    sql: `
      CREATE TRIGGER IF NOT EXISTS main.memory_index_paths_fts_after_update
      AFTER UPDATE OF id, path, source ON ${MEMORY_INDEX_SOURCES_TABLE}
      BEGIN
        DELETE FROM ${MEMORY_INDEX_PATHS_FTS_TABLE}
        WHERE rowid = OLD.id;
        INSERT INTO ${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source)
        VALUES (NEW.id, NEW.path, NEW.source);
      END;
    `,
  },
  {
    name: "memory_index_paths_fts_after_delete",
    sql: `
      CREATE TRIGGER IF NOT EXISTS main.memory_index_paths_fts_after_delete
      AFTER DELETE ON ${MEMORY_INDEX_SOURCES_TABLE}
      BEGIN
        DELETE FROM ${MEMORY_INDEX_PATHS_FTS_TABLE}
        WHERE rowid = OLD.id;
      END;
    `,
  },
] as const;

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
  ["mtime", "INTEGER"],
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
      column.type !== expectedType ||
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

function assertLegacyRowsCopied(db: DatabaseSync, query: string, tableName: string): void {
  const row = db.prepare(query).get() as { missing?: unknown } | undefined;
  if (Number(row?.missing ?? 0) > 0) {
    throw new Error(`legacy memory ${tableName} rows conflict with canonical memory index rows`);
  }
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
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        UNIQUE (path, source)
      );
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
  assertLegacyRowsCopied(
    db,
    `SELECT COUNT(*) AS missing
     FROM ${schema}.meta AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${MEMORY_INDEX_META_TABLE} AS canonical
       WHERE canonical.key = legacy.key AND canonical.value IS legacy.value
     )`,
    "meta",
  );
  assertLegacyRowsCopied(
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
  assertLegacyRowsCopied(
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
      );
      INSERT OR IGNORE INTO main.${MEMORY_EMBEDDING_CACHE_TABLE} (
        provider, model, provider_key, hash, embedding, dims, updated_at
      )
      SELECT provider, model, provider_key, hash, embedding, dims, updated_at
      FROM ${schema}.embedding_cache;
    `);
    assertLegacyRowsCopied(
      db,
      `SELECT COUNT(*) AS missing
       FROM ${schema}.embedding_cache AS legacy
       WHERE NOT EXISTS (
         SELECT 1 FROM main.${MEMORY_EMBEDDING_CACHE_TABLE} AS canonical
         WHERE canonical.provider = legacy.provider
           AND canonical.model = legacy.model
           AND canonical.provider_key = legacy.provider_key
           AND canonical.hash = legacy.hash
           AND canonical.embedding IS legacy.embedding
           AND canonical.dims IS legacy.dims
           AND canonical.updated_at IS legacy.updated_at
       )`,
      "embedding_cache",
    );
  }
}

function migrateLegacyMemoryIndexTables(
  db: DatabaseSync,
  preservedEmbeddingCacheTable?: string,
): void {
  if (!hasLegacyMemoryIndexTables(db)) {
    return;
  }

  db.exec("SAVEPOINT migrate_legacy_memory_index_tables");
  try {
    copyLegacyMemoryIndexRows(db, "main", preservedEmbeddingCacheTable);
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

/** Drop the canonical source-to-path-FTS maintenance triggers. */
export function dropMemoryPathFtsTriggers(db: DatabaseSync): void {
  for (const trigger of MEMORY_PATH_FTS_TRIGGER_DEFINITIONS) {
    db.exec(`DROP TRIGGER IF EXISTS main.${trigger.name}`);
  }
}

/** Install the canonical source-to-path-FTS maintenance triggers. */
export function ensureMemoryPathFtsTriggers(db: DatabaseSync): void {
  // The named integer source identity survives VACUUM and gives every
  // FTS update/delete a direct rowid lookup instead of a virtual-table scan.
  for (const trigger of MEMORY_PATH_FTS_TRIGGER_DEFINITIONS) {
    db.exec(trigger.sql);
  }
}

function ensureMemoryPathFtsSchema(params: { db: DatabaseSync; tokenizeClause: string }): void {
  params.db.exec("SAVEPOINT ensure_memory_index_paths_fts");
  try {
    params.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORY_INDEX_PATHS_FTS_TABLE} USING fts5(
        path,
        source UNINDEXED
        ${params.tokenizeClause}
      );
      -- The initial copy and trigger installation share this savepoint. Once
      -- populated, the triggers own completeness; per-row FTS probes are too costly.
      INSERT INTO ${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source)
      SELECT id, path, source
      FROM ${MEMORY_INDEX_SOURCES_TABLE}
      WHERE NOT EXISTS (SELECT 1 FROM ${MEMORY_INDEX_PATHS_FTS_TABLE} LIMIT 1);
    `);
    ensureMemoryPathFtsTriggers(params.db);
    params.db.exec("RELEASE ensure_memory_index_paths_fts");
  } catch (err) {
    params.db.exec("ROLLBACK TO ensure_memory_index_paths_fts");
    params.db.exec("RELEASE ensure_memory_index_paths_fts");
    throw err;
  }
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
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_SOURCES_TABLE} (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      UNIQUE (path, source)
    );
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
    );
    CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_STATE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    );
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
  migrateLegacyMemoryIndexTables(params.db, params.embeddingCacheTable);
  if (params.cacheEnabled) {
    const updatedAtIndex =
      embeddingCacheTable === MEMORY_EMBEDDING_CACHE_TABLE
        ? "idx_memory_embedding_cache_updated_at"
        : "idx_embedding_cache_updated_at";
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS ${embeddingCacheTable} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
      CREATE INDEX IF NOT EXISTS ${updatedAtIndex}
        ON ${embeddingCacheTable}(updated_at);
    `);
  }

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
      // The shipped generic-table migration and a later FTS enablement both
      // create an empty derived table beside already-canonical chunk rows.
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
