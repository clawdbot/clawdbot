import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const AGENT_SCOPED_MEMORY_TABLES = [
  "memory_storage_roots",
  "memory_stores",
  "memory_policies",
  "memory_policy_revisions",
  "memory_policy_entries",
  "memory_resources",
  "memory_resource_revisions",
  "memory_resource_subjects",
  "memory_scoped_chunks",
  "memory_scoped_chunk_vectors",
  "memory_migrations",
] as const;

export const AGENT_SCOPED_MEMORY_FTS_TABLE = "memory_scoped_chunks_fts";
export const AGENT_SCOPED_MEMORY_FTS_SHADOW_TABLES = [
  "memory_scoped_chunks_fts_config",
  "memory_scoped_chunks_fts_content",
  "memory_scoped_chunks_fts_data",
  "memory_scoped_chunks_fts_docsize",
  "memory_scoped_chunks_fts_idx",
] as const;

export const AGENT_SCOPED_MEMORY_FTS_TRIGGER_DEFINITIONS = [
  {
    name: "memory_scoped_chunks_fts_after_insert",
    sql: `
      CREATE TRIGGER IF NOT EXISTS memory_scoped_chunks_fts_after_insert
      AFTER INSERT ON memory_scoped_chunks
      BEGIN
        INSERT INTO memory_scoped_chunks_fts(rowid, text, chunk_id, revision_id, start_line, end_line)
        VALUES (new.chunk_key, new.text, new.chunk_id, new.revision_id, new.start_line, new.end_line);
      END;
    `,
  },
  {
    name: "memory_scoped_chunks_fts_after_delete",
    sql: `
      CREATE TRIGGER IF NOT EXISTS memory_scoped_chunks_fts_after_delete
      AFTER DELETE ON memory_scoped_chunks
      BEGIN
        DELETE FROM memory_scoped_chunks_fts WHERE rowid = old.chunk_key;
      END;
    `,
  },
  {
    name: "memory_scoped_chunks_fts_after_update",
    sql: `
      CREATE TRIGGER IF NOT EXISTS memory_scoped_chunks_fts_after_update
      AFTER UPDATE OF text, chunk_id, revision_id, start_line, end_line ON memory_scoped_chunks
      BEGIN
        DELETE FROM memory_scoped_chunks_fts WHERE rowid = old.chunk_key;
        INSERT INTO memory_scoped_chunks_fts(rowid, text, chunk_id, revision_id, start_line, end_line)
        VALUES (new.chunk_key, new.text, new.chunk_id, new.revision_id, new.start_line, new.end_line);
      END;
    `,
  },
] as const;

const SCOPED_MEMORY_SCHEMA_START = "CREATE TABLE IF NOT EXISTS memory_storage_roots (";
const SCOPED_MEMORY_SCHEMA_END = "CREATE TABLE IF NOT EXISTS standing_intents (";

function extractScopedMemorySchema(): string {
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(SCOPED_MEMORY_SCHEMA_START);
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(SCOPED_MEMORY_SCHEMA_END, start);
  if (start < 0 || end <= start) {
    throw new Error("canonical scoped memory schema markers are missing");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.slice(start, end).trim();
}

/** Canonical additive schema for scoped resources, policy, indexes, and receipts. */
export const AGENT_SCOPED_MEMORY_SCHEMA_SQL = extractScopedMemorySchema();

/** Lazily install the full idempotent group; do not cache transaction-local success. */
export function ensureOpenClawAgentScopedMemorySchema(db: DatabaseSync): void {
  const ensure = () => {
    // A partially applied group is completed rather than inferred from one marker table.
    db.exec(AGENT_SCOPED_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Canonical additive DDL only.
  };
  if (db.isTransaction) {
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
}
