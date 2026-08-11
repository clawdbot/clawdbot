import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "./openclaw-runtime-sqlite.js";

const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";
export const MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE = "memory_index_chunk_recall_metadata";

export const MEMORY_INDEX_CHUNK_RECALL_METADATA_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE} (
    chunk_id TEXT PRIMARY KEY,
    importance INTEGER CHECK (importance IS NULL OR importance BETWEEN 1 AND 10),
    triggers TEXT,
    project_key TEXT,
    FOREIGN KEY (chunk_id) REFERENCES ${MEMORY_INDEX_CHUNKS_TABLE}(id) ON DELETE CASCADE
  ) STRICT;
`;

function readMemoryChunkColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${MEMORY_INDEX_CHUNKS_TABLE})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName),
  );
}

function legacyRecallMetadataColumns(db: DatabaseSync): string[] {
  const columns = readMemoryChunkColumns(db);
  return ["importance", "triggers", "project_key"].filter((column) => columns.has(column));
}

export function hasLegacyMemoryRecallMetadataColumns(db: DatabaseSync): boolean {
  return legacyRecallMetadataColumns(db).length > 0;
}

export function ensureMemoryRecallMetadataSchema(db: DatabaseSync): void {
  const initialLegacyColumns = legacyRecallMetadataColumns(db);
  if (
    initialLegacyColumns.length === 0 &&
    tableExists(db, MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE)
  ) {
    return;
  }
  const ensure = () => {
    db.exec(MEMORY_INDEX_CHUNK_RECALL_METADATA_SCHEMA_SQL);
    const columns = new Set(legacyRecallMetadataColumns(db));
    if (columns.size === 0) {
      return;
    }

    // These columns landed only on unreleased main. Move their data into an
    // additive owner table so older binaries still see their canonical chunk table.
    const importance = columns.has("importance") ? "importance" : "NULL";
    const triggers = columns.has("triggers") ? "triggers" : "NULL";
    const projectKey = columns.has("project_key") ? "project_key" : "NULL";
    db.exec(`
      INSERT INTO ${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE} (
        chunk_id, importance, triggers, project_key
      )
      SELECT id, ${importance}, ${triggers}, ${projectKey}
      FROM ${MEMORY_INDEX_CHUNKS_TABLE}
      WHERE ${importance} IS NOT NULL
         OR ${triggers} IS NOT NULL
         OR ${projectKey} IS NOT NULL
      ON CONFLICT(chunk_id) DO UPDATE SET
        importance=excluded.importance,
        triggers=excluded.triggers,
        project_key=excluded.project_key;
    `);
    for (const column of ["project_key", "triggers", "importance"]) {
      if (columns.has(column)) {
        db.exec(`ALTER TABLE ${MEMORY_INDEX_CHUNKS_TABLE} DROP COLUMN ${column}`);
      }
    }
  };
  if (db.isTransaction) {
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
}
