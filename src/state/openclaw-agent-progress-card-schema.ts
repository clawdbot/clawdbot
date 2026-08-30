import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL } from "./openclaw-agent-board-schema.js";

export const SESSION_PROGRESS_CARDS_TABLE = "session_progress_cards";
const PROGRESS_CARD_SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${SESSION_PROGRESS_CARDS_TABLE} (`;
const PROGRESS_CARD_SCHEMA_END = "CREATE TABLE IF NOT EXISTS heartbeat_outcomes (";

function splitProgressCardSchema(sql: string): {
  progressCard: string;
  withoutProgressCard: string;
} {
  const start = sql.indexOf(PROGRESS_CARD_SCHEMA_START);
  const end = sql.indexOf(PROGRESS_CARD_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw agent progress-card schema markers are missing.");
  }
  return {
    progressCard: sql.slice(start, end),
    withoutProgressCard: `${sql.slice(0, start)}${sql.slice(end)}`,
  };
}

const progressCardSchema = splitProgressCardSchema(OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL);

export const AGENT_PROGRESS_CARD_SCHEMA_SQL = progressCardSchema.progressCard;
export const AGENT_SCHEMA_WITHOUT_PROGRESS_CARD_SQL = progressCardSchema.withoutProgressCard;

/** Ensure the additive progress-card table inside the caller's write transaction. */
export function ensureOpenClawAgentProgressCardSchemaInTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) {
    throw new Error("progress-card schema ensure requires an active transaction");
  }
  db.exec(AGENT_PROGRESS_CARD_SCHEMA_SQL); // sqlite-allow-raw -- Canonical DDL bootstrap for the lazy progress-card schema.
}
