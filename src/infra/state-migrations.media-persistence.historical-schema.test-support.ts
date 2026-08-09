import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";

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
  let sql = OPENCLAW_AGENT_SCHEMA_SQL.replace(
    "  entry_valid INTEGER NOT NULL DEFAULT 0 CHECK (entry_valid IN (-1, 0, 1)),\n",
    "",
  );
  sql = removeSchemaRange(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_entry_valid_pending",
    "CREATE TABLE IF NOT EXISTS session_windows (",
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
