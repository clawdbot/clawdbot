import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const SESSION_PENDING_INPUTS_TABLE = "session_pending_inputs";
const presentDatabases = new WeakSet<DatabaseSync>();
let absentDatabases = new WeakSet<DatabaseSync>();

/** Cache feature-table presence per connection; first use invalidates earlier absence checks. */
export function hasSessionPendingInputsSchema(db: DatabaseSync): boolean {
  if (presentDatabases.has(db)) {
    return true;
  }
  if (!db.isTransaction && absentDatabases.has(db)) {
    return false;
  }
  const present = Boolean(
    // sqlite-allow-raw -- Feature-local schema discovery, never application data.
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(SESSION_PENDING_INPUTS_TABLE),
  );
  if (!db.isTransaction) {
    (present ? presentDatabases : absentDatabases).add(db);
  }
  return present;
}

/** Lazily installs accepted-input custody without changing either schema version marker. */
export function ensureSessionPendingInputsSchema(db: DatabaseSync): void {
  if (hasSessionPendingInputsSchema(db)) {
    return;
  }
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(
    `CREATE TABLE IF NOT EXISTS ${SESSION_PENDING_INPUTS_TABLE} (`,
  );
  if (start < 0) {
    throw new Error("OpenClaw pending-input schema marker is missing.");
  }
  const nested = db.isTransaction;
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL.slice(start)); // sqlite-allow-raw -- Canonical additive DDL only.
  });
  absentDatabases = new WeakSet();
  if (!nested) {
    presentDatabases.add(db);
  }
}
