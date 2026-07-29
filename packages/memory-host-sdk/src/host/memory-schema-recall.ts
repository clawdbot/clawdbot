import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "./openclaw-runtime-sqlite.js";

const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";

function readMemoryChunkColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${MEMORY_INDEX_CHUNKS_TABLE})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

export function ensureMemoryRecallMetadataColumns(db: DatabaseSync): void {
  const initialColumns = readMemoryChunkColumns(db);
  if (
    initialColumns.has("importance") &&
    initialColumns.has("triggers") &&
    initialColumns.has("project_key")
  ) {
    return;
  }
  const ensure = () => {
    const columns = readMemoryChunkColumns(db);
    // Null metadata is the compatibility contract for existing indexes: it is
    // ranking-neutral and never makes a chunk eligible for trigger injection.
    if (!columns.has("importance")) {
      db.exec(
        `ALTER TABLE ${MEMORY_INDEX_CHUNKS_TABLE} ADD COLUMN importance INTEGER ` +
          `CHECK (importance IS NULL OR importance BETWEEN 1 AND 10)`,
      );
    }
    if (!columns.has("triggers")) {
      db.exec(`ALTER TABLE ${MEMORY_INDEX_CHUNKS_TABLE} ADD COLUMN triggers TEXT`);
    }
    if (!columns.has("project_key")) {
      db.exec(`ALTER TABLE ${MEMORY_INDEX_CHUNKS_TABLE} ADD COLUMN project_key TEXT`);
    }
  };
  if (db.isTransaction) {
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
}
