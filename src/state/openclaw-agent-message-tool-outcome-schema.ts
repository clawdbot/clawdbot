import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const MESSAGE_TOOL_RUN_OUTCOMES_TABLE = "message_tool_run_outcomes";

const SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${MESSAGE_TOOL_RUN_OUTCOMES_TABLE} (`;
const SCHEMA_END = "CREATE TABLE IF NOT EXISTS transcript_events (";
const ENSURED_DATABASES = new WeakSet<DatabaseSync>();

function messageToolRunOutcomeSchemaSql(): string {
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(SCHEMA_START);
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw message-tool run outcome schema markers are missing.");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.slice(start, end);
}

/** Lazily installs the additive outcome table on first use. */
export function ensureMessageToolRunOutcomeSchema(db: DatabaseSync): void {
  if (ENSURED_DATABASES.has(db)) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(messageToolRunOutcomeSchemaSql()); // sqlite-allow-raw -- Canonical additive DDL only.
  });
  ENSURED_DATABASES.add(db);
}
