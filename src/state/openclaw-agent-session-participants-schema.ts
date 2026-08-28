import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const SESSION_PARTICIPANTS_TABLE = "session_participants";

const SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${SESSION_PARTICIPANTS_TABLE} (`;
const SCHEMA_END = "CREATE TABLE IF NOT EXISTS session_key_contract (";
const ensuredDatabases = new WeakSet<DatabaseSync>();

export function sessionParticipantsSchemaSql(): string {
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(SCHEMA_START);
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw session participant schema markers are missing.");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.slice(start, end);
}

/** Lazily installs the additive participant table on the first admitted prompt. */
export function ensureSessionParticipantsSchema(database: DatabaseSync): boolean {
  if (ensuredDatabases.has(database)) {
    return false;
  }
  const ensure = () => {
    // sqlite-allow-raw -- canonical additive DDL only.
    database.exec(sessionParticipantsSchemaSql());
  };
  if (database.isTransaction) {
    ensure();
    return true;
  }
  runSqliteImmediateTransactionSync(database, ensure);
  ensuredDatabases.add(database);
  return false;
}

/** Cache a first-use ensure only after its owning transaction commits. */
export function confirmSessionParticipantsSchemaEnsured(database: DatabaseSync): void {
  ensuredDatabases.add(database);
}
