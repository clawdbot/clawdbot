import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL } from "./openclaw-agent-board-schema.js";

const SHARING_SCHEMA_START = "CREATE TABLE IF NOT EXISTS session_members (";
const SHARING_SCHEMA_END = "CREATE TABLE IF NOT EXISTS heartbeat_outcomes (";

function splitSessionSharingSchema(sql: string): { sharing: string; withoutSharing: string } {
  const start = sql.indexOf(SHARING_SCHEMA_START);
  const end = sql.indexOf(SHARING_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw agent session-sharing schema markers are missing.");
  }
  return {
    sharing: sql.slice(start, end),
    withoutSharing: `${sql.slice(0, start)}${sql.slice(end)}`,
  };
}

const sessionSharingSchema = splitSessionSharingSchema(OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL);

export const AGENT_SCHEMA_WITHOUT_LAZY_SURFACES_SQL = sessionSharingSchema.withoutSharing;

/** Adds the phase-2 collaboration table on first use without a schema-version bump. */
export function ensureOpenClawAgentSessionSharingSchemaInTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) {
    throw new Error("session sharing schema ensure requires an active transaction");
  }
  db.exec(sessionSharingSchema.sharing); // sqlite-allow-raw -- Canonical DDL for an additive lazy table.
}
