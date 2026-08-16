// Memory Host SDK module owns derived FTS schema and rebuild behavior.
import type { DatabaseSync } from "node:sqlite";

export const MEMORY_INDEX_SOURCES_TABLE = "memory_index_sources";
export const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";
export const MEMORY_INDEX_FTS_TABLE = "memory_index_chunks_fts";
export const MEMORY_INDEX_PATHS_FTS_TABLE = "memory_index_paths_fts";

type FtsTableSchemaStatus = "missing" | "matching" | "mismatched" | "not-fts";

/** Check every persisted FTS column declaration and supported table option. */
function ftsTableMatchesSchema(params: {
  db: DatabaseSync;
  tableName: string;
  expectedColumns: readonly string[];
  tokenizeClause: string;
}): FtsTableSchemaStatus {
  const table = params.db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE")
    .get(params.tableName) as { sql?: unknown } | undefined;
  if (typeof table?.sql !== "string") {
    return "missing";
  }
  const definition =
    /^\s*CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s(]+)\s+USING\s+fts5\s*\(([\s\S]*)\)\s*$/iu.exec(
      table.sql,
    )?.[1];
  if (definition === undefined) {
    return "not-fts";
  }

  const declarations = definition
    .split(",")
    .map((declaration) => declaration.trim().replace(/\s+/g, " ").toLowerCase());
  const expectedDeclarations = params.expectedColumns.map((column, index) =>
    index === 0 ? column : `${column} unindexed`,
  );
  if (
    declarations.length < expectedDeclarations.length ||
    expectedDeclarations.some((column, index) => declarations[index] !== column)
  ) {
    return "mismatched";
  }

  // The configured tokenizer is the sole supported FTS option. Accept the
  // shipped explicit unicode61 spelling, but rebuild contentless/external tables.
  const options = declarations.slice(expectedDeclarations.length);
  const tokenizerOption = options[0] ?? "";
  const tokenizerMatches = params.tokenizeClause.includes("trigram")
    ? options.length === 1 &&
      /^tokenize\s*=\s*(['"])trigram case_sensitive 0\1$/u.test(tokenizerOption)
    : options.length === 0 ||
      (options.length === 1 && /^tokenize\s*=\s*(['"])unicode61\1$/u.test(tokenizerOption));
  if (!tokenizerMatches) {
    return "mismatched";
  }

  const columns = params.db
    .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
    .all(params.tableName) as Array<{ name?: unknown }>;
  return columns.length === params.expectedColumns.length &&
    columns.every((column, index) => column.name === params.expectedColumns[index])
    ? "matching"
    : "mismatched";
}

/** Remove only derived FTS state whose persisted schema no longer matches. */
function dropMismatchedFtsTable(params: {
  db: DatabaseSync;
  tableName: string;
  expectedColumns: readonly string[];
  tokenizeClause: string;
}): void {
  const status = ftsTableMatchesSchema(params);
  if (status === "missing" || status === "matching") {
    return;
  }

  // Deprecated custom names never establish ownership of an existing ordinary
  // table. Failing closed here prevents a name collision from deleting memories.
  if (
    status === "not-fts" &&
    params.tableName !== MEMORY_INDEX_FTS_TABLE &&
    params.tableName !== MEMORY_INDEX_PATHS_FTS_TABLE
  ) {
    throw new Error(`Memory FTS table "${params.tableName}" collides with a non-FTS table`);
  }

  // Path triggers target this table; remove them before replacing its schema
  // so canonical source writes never run against missing derived columns.
  if (params.tableName === MEMORY_INDEX_PATHS_FTS_TABLE) {
    dropMemoryPathFtsTriggers(params.db);
  }
  params.db.exec(`DROP TABLE ${params.tableName}`);
}

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

export function rebuildMemoryChunkFts(db: DatabaseSync, ftsTable: string): void {
  db.exec(`
    DELETE FROM ${ftsTable};
    INSERT INTO ${ftsTable} (
      text, id, path, source, model, start_line, end_line
    )
    SELECT text, id, path, source, model, start_line, end_line
    FROM ${MEMORY_INDEX_CHUNKS_TABLE};
  `);
}

/** Reconcile and backfill the derived body index in one atomic savepoint. */
export function ensureMemoryChunkFtsSchema(params: {
  db: DatabaseSync;
  ftsTable: string;
  tokenizeClause: string;
}): void {
  // Body and path indexes have incompatible columns and maintenance triggers.
  // Reject SQLite's case-insensitive path alias before replacing either index.
  if (params.ftsTable.toLowerCase() === MEMORY_INDEX_PATHS_FTS_TABLE.toLowerCase()) {
    throw new Error(`Memory body FTS table "${params.ftsTable}" collides with the path FTS index`);
  }

  params.db.exec("SAVEPOINT ensure_memory_index_chunks_fts");
  try {
    dropMismatchedFtsTable({
      db: params.db,
      tableName: params.ftsTable,
      expectedColumns: ["text", "id", "path", "source", "model", "start_line", "end_line"],
      tokenizeClause: params.tokenizeClause,
    });
    params.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n` +
        `  text,\n` +
        `  id UNINDEXED,\n` +
        `  path UNINDEXED,\n` +
        `  source UNINDEXED,\n` +
        `  model UNINDEXED,\n` +
        `  start_line UNINDEXED,\n` +
        `  end_line UNINDEXED\n` +
        `${params.tokenizeClause});`,
    );
    // Empty derived tables are rebuilt from canonical chunks; populated,
    // matching indexes stay untouched on ordinary schema ensures.
    params.db.exec(`
      INSERT INTO ${params.ftsTable} (
        text, id, path, source, model, start_line, end_line
      )
      SELECT text, id, path, source, model, start_line, end_line
      FROM ${MEMORY_INDEX_CHUNKS_TABLE}
      WHERE NOT EXISTS (SELECT 1 FROM ${params.ftsTable} LIMIT 1);
    `);
    params.db.exec("RELEASE ensure_memory_index_chunks_fts");
  } catch (err) {
    params.db.exec("ROLLBACK TO ensure_memory_index_chunks_fts");
    params.db.exec("RELEASE ensure_memory_index_chunks_fts");
    throw err;
  }
}

export function dropDisabledMemoryFts(db: DatabaseSync, ftsTable: string, enabled: boolean): void {
  if (enabled) {
    return;
  }

  // Path triggers must disappear before their derived table so canonical
  // source writes stay independent of the selected body FTS table.
  dropMemoryPathFtsTriggers(db);
  db.exec(`DROP TABLE IF EXISTS ${MEMORY_INDEX_PATHS_FTS_TABLE}`);

  if (ftsTable === MEMORY_INDEX_FTS_TABLE) {
    db.exec(`DROP TABLE IF EXISTS ${ftsTable}`);
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

export function ensureMemoryPathFtsSchema(params: {
  db: DatabaseSync;
  tokenizeClause: string;
}): void {
  params.db.exec("SAVEPOINT ensure_memory_index_paths_fts");
  try {
    dropMismatchedFtsTable({
      db: params.db,
      tableName: MEMORY_INDEX_PATHS_FTS_TABLE,
      expectedColumns: ["path", "source"],
      tokenizeClause: params.tokenizeClause,
    });
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
