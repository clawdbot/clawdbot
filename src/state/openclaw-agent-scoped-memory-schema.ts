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
  "memory_revision_policy_requirements",
  "memory_lineage_edges",
  "memory_resource_subjects",
  "memory_scoped_chunks",
  "memory_scoped_chunk_vectors",
  "memory_write_intents",
  "memory_audit_outbox",
  "memory_migrations",
  "memory_policy_sets",
  "memory_policy_set_members",
  "memory_run_exposures",
  "memory_run_exposure_resources",
  "memory_preoutput_exposure_ledger",
  "memory_preoutput_exposure_authorization_facts",
  "memory_preoutput_exposure_enterprise_membership_sets",
  "memory_preoutput_exposure_enterprise_memberships",
  "transcript_event_memory_policies",
  "transcript_event_memory_policy_details",
  "transcript_event_memory_policy_transitions",
  "memory_compaction_policies",
  "memory_compaction_policy_sources",
  "memory_projection_targets",
  "memory_projections",
  "memory_postbox_settings",
  "memory_postbox_source_handles",
  "memory_postbox_rate_limits",
  "memory_postbox_items",
  "memory_postbox_reviewed_copies",
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

const POSTBOX_PURGE_TRIGGER_MARKER = "NEW.state = 'purged'";
const POSTBOX_PURGE_TRIGGER_SQL = `
  CREATE TRIGGER memory_postbox_items_immutable_provenance
  BEFORE UPDATE OF item_id, agent_id, source_handle_id, target_store_id, source_channel_ref,
    sender_evidence_ref, content, content_hash, created_at
  ON memory_postbox_items
  WHEN
    NEW.item_id <> OLD.item_id OR
    NEW.agent_id <> OLD.agent_id OR
    NEW.source_handle_id <> OLD.source_handle_id OR
    NEW.target_store_id <> OLD.target_store_id OR
    NEW.source_channel_ref <> OLD.source_channel_ref OR
    NEW.sender_evidence_ref <> OLD.sender_evidence_ref OR
    NEW.created_at <> OLD.created_at OR
    (
      (NEW.content <> OLD.content OR NEW.content_hash <> OLD.content_hash) AND
      NOT (
        OLD.state IN ('postbox', 'reviewed', 'rejected') AND
        NEW.state = 'purged' AND
        NEW.content = '' AND
        NEW.content_hash = ''
      )
    )
  BEGIN
    SELECT RAISE(ABORT, 'memory postbox provenance is immutable');
  END;
`;

function repairPostboxPurgeTrigger(db: DatabaseSync): void {
  const trigger = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get("memory_postbox_items_immutable_provenance") as { sql?: unknown } | undefined;
  if (typeof trigger?.sql === "string" && trigger.sql.includes(POSTBOX_PURGE_TRIGGER_MARKER)) {
    return;
  }
  // Existing additive databases have the older immutable trigger. Replace only that trigger so
  // a purge can redact the body/digest while every identity-bearing provenance field stays fixed.
  db.exec("DROP TRIGGER IF EXISTS memory_postbox_items_immutable_provenance");
  db.exec(POSTBOX_PURGE_TRIGGER_SQL); // sqlite-allow-raw -- canonical trigger convergence.
}

/** Lazily install the full idempotent group; do not cache transaction-local success. */
export function ensureOpenClawAgentScopedMemorySchema(db: DatabaseSync): void {
  const ensure = () => {
    // A partially applied group is completed rather than inferred from one marker table.
    db.exec(AGENT_SCOPED_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Canonical additive DDL only.
    repairPostboxPurgeTrigger(db);
  };
  if (db.isTransaction) {
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
}
