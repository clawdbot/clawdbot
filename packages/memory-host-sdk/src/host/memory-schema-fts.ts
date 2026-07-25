// Memory Host SDK module owns derived FTS schema and rebuild behavior.
import type { DatabaseSync } from "node:sqlite";

export const MEMORY_INDEX_SOURCES_TABLE = "memory_index_sources";
export const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";
export const MEMORY_INDEX_FTS_TABLE = "memory_index_chunks_fts";
export const MEMORY_INDEX_PATHS_FTS_TABLE = "memory_index_paths_fts";

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

export function dropDisabledMemoryChunkFts(
  db: DatabaseSync,
  ftsTable: string,
  enabled: boolean,
): void {
  if (!enabled && ftsTable === MEMORY_INDEX_FTS_TABLE) {
    // Body FTS has no maintenance triggers while disabled. Recreate it from
    // canonical chunks on enable instead of retaining a partial derived index.
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
