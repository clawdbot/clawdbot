import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { DURABLE_RUNTIME_SCHEMA_SQL } from "./schema.generated.js";

const DURABLE_RUNTIME_TABLES = [
  "durable_execution_records",
  "durable_event_evidence",
  "durable_execution_steps",
  "durable_payload_refs",
  "durable_run_correlations",
  "durable_timer_obligations",
  "durable_signal_evidence",
  "wake_obligations",
  "uncertainty_facts",
  "delivery_attempt_evidence",
] as const;

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName),
  );
}

/** Open an already-installed durable schema without creating or migrating state. */
export function openDurableRuntimeSchemaReadOnly(pathname: string): DatabaseSync {
  if (!existsSync(pathname)) {
    throw new Error(`Durable runtime database ${pathname} is not initialized.`);
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    const missingTable = DURABLE_RUNTIME_TABLES.find((tableName) => !hasTable(db, tableName));
    if (missingTable) {
      throw new Error(
        `Durable runtime database ${pathname} is missing required table ${missingTable}.`,
      );
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Lazily install the additive durable tables inside the shared state database. */
export function ensureDurableRuntimeSchema(db: DatabaseSync): void {
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(DURABLE_RUNTIME_SCHEMA_SQL);
  });
}
