import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";

const HISTORICAL_AGENT_LEASE_SCHEMA = `CREATE TABLE IF NOT EXISTS state_leases (
  scope TEXT NOT NULL,
  lease_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER,
  heartbeat_at INTEGER,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, lease_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_state_leases_expiry
  ON state_leases(expires_at, scope, lease_key)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_state_leases_owner
  ON state_leases(owner, updated_at DESC);

`;

function restoreHistoricalAgentLeaseSchema(sql: string): string {
  const marker = "CREATE TABLE IF NOT EXISTS session_nodes (";
  if (!sql.includes(marker)) {
    throw new Error(`Historical agent schema marker is missing: ${marker}`);
  }
  return sql.replace(marker, `${HISTORICAL_AGENT_LEASE_SCHEMA}${marker}`);
}

function removeSchemaRange(sql: string, startMarker: string, endMarker: string): string {
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(`Historical agent schema marker is missing: ${startMarker}`);
  }
  return sql.slice(0, start) + sql.slice(end);
}

/** Exact schema bytes from 509a5f0373764, derived from current SQL with later additions removed. */
export function historicalV15AgentSchemaSql(): string {
  let sql = restoreHistoricalAgentLeaseSchema(OPENCLAW_AGENT_SCHEMA_SQL)
    .replace("  entry_valid INTEGER NOT NULL DEFAULT 0 CHECK (entry_valid IN (-1, 0, 1)),\n", "")
    .replace("  project_id TEXT,\n", "")
    .replace("  route_context_json TEXT,\n", "")
    .replace(
      "  owner_actor_type TEXT,\n  owner_actor_id TEXT,\n  owner_assigned_by_type TEXT,\n  owner_assigned_by_id TEXT,\n  owner_assigned_at INTEGER,\n",
      "",
    );
  sql = removeSchemaRange(
    sql,
    "CREATE TABLE IF NOT EXISTS session_progress_cards (",
    "CREATE TABLE IF NOT EXISTS heartbeat_outcomes (",
  );
  sql = removeSchemaRange(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_entry_valid_pending",
    "CREATE TABLE IF NOT EXISTS session_windows (",
  );
  sql = removeSchemaRange(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_agent_session_windows_session_key",
    "CREATE INDEX IF NOT EXISTS idx_agent_session_windows_created_at",
  );
  sql = removeSchemaRange(
    sql,
    "-- Older same-version writers preserve the envelope while updating the association.",
    "CREATE INDEX IF NOT EXISTS idx_agent_session_conversations_conversation",
  );
  sql = removeSchemaRange(
    sql,
    "CREATE TABLE IF NOT EXISTS message_tool_run_outcomes (",
    "CREATE TABLE IF NOT EXISTS transcript_events (",
  );
  sql = removeSchemaRange(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_agent_transcript_event_identity_sequence",
    "CREATE INDEX IF NOT EXISTS idx_agent_transcript_event_parent",
  );
  sql = removeSchemaRange(
    sql,
    "CREATE TABLE IF NOT EXISTS context_engine_turn_outbox (",
    "CREATE TABLE IF NOT EXISTS cache_entries (",
  );
  sql = removeSchemaRange(
    sql,
    "CREATE TABLE IF NOT EXISTS memory_index_chunk_recall_metadata (",
    "CREATE TABLE IF NOT EXISTS memory_embedding_cache (",
  );
  sql = removeSchemaRange(
    sql,
    "-- Canonical cold-tier owner for reclaimed transcript generations.",
    "CREATE TABLE IF NOT EXISTS transcript_rewrite_watermarks (",
  );
  return removeSchemaRange(
    sql,
    "CREATE TABLE IF NOT EXISTS standing_intents (",
    "CREATE TABLE IF NOT EXISTS session_transcript_index_state (",
  );
}

/** Exact schema bytes from v2026.7.2-beta.4, the first tagged agent schema v14. */
export function historicalV14AgentSchemaSql(): string {
  return removeSchemaRange(
    historicalV15AgentSchemaSql(),
    "\nCREATE TABLE IF NOT EXISTS session_suggestions (",
    "CREATE TABLE IF NOT EXISTS board_tabs (",
  );
}
