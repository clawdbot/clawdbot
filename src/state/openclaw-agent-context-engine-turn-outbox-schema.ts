import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const CONTEXT_ENGINE_TURN_OUTBOX_TABLE = "context_engine_turn_outbox";

const OUTBOX_SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${CONTEXT_ENGINE_TURN_OUTBOX_TABLE} (`;
const OUTBOX_SCHEMA_END = "CREATE TABLE IF NOT EXISTS cache_entries (";
const ENSURED_DATABASES = new WeakSet<DatabaseSync>();

function contextEngineTurnOutboxSchemaSql(): string {
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(OUTBOX_SCHEMA_START);
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(OUTBOX_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw context-engine turn outbox schema markers are missing.");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.slice(start, end);
}

/** Lazily installs the additive context-engine turn outbox on first use. */
export function ensureContextEngineTurnOutboxSchema(db: DatabaseSync): void {
  if (ENSURED_DATABASES.has(db)) {
    return;
  }
  const ensure = () => {
    db.exec(contextEngineTurnOutboxSchemaSql()); // sqlite-allow-raw -- Canonical additive DDL only.
  };
  if (db.isTransaction) {
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
  ENSURED_DATABASES.add(db);
}
