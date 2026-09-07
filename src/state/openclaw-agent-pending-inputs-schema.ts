import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

export const SESSION_PENDING_INPUTS_TABLE = "session_pending_inputs";
const presentDatabases = new WeakSet<DatabaseSync>();
const completeDatabases = new WeakSet<DatabaseSync>();
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
  if (completeDatabases.has(db)) {
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
    ensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id TEXT");
  });
  absentDatabases = new WeakSet();
  if (!nested) {
    presentDatabases.add(db);
    completeDatabases.add(db);
  }
}

/** Existing same-version stores converge through Doctor/open; absent tables stay feature-local. */
export function hasPendingInputConsumptionColumnMigration(db: DatabaseSync): boolean {
  return (
    hasSessionPendingInputsSchema(db) &&
    !tableHasColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id")
  );
}

export function ensurePendingInputConsumptionColumn(db: DatabaseSync): void {
  ensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id TEXT");
}

/** Read-only callers can inspect pre-feature stores without installing schema. */
export function hasPendingInputConsumptionColumn(db: DatabaseSync): boolean {
  if (completeDatabases.has(db)) {
    return true;
  }
  const present = tableHasColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id");
  if (present && !db.isTransaction) {
    completeDatabases.add(db);
  }
  return present;
}
