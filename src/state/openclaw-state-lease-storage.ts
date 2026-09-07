import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import {
  assertExistingOpenClawStateSchema,
  runExistingOpenClawStateWriteTransaction,
} from "./openclaw-state-db-existing-write.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export type OpenClawStateLeaseDatabase = {
  scope: "shared";
  options?: OpenClawStateDatabaseOptions;
  /** Storage compatibility only, never authority. Acquisition still claims the real lease. */
  schemaPolicy?: "existing";
};
const leaseSchema = ["schema_meta", "state_leases"]
  .map((table) => {
    const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const marker = ") STRICT;";
    const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start);
    if (start < 0 || end < 0) {
      throw new Error("Existing lease schema is unavailable.");
    }
    return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + marker.length);
  })
  .join("\n");

export function assertExistingLeasePublicationSchema(db: DatabaseSync, databasePath: string): void {
  assertExistingOpenClawStateSchema(db, databasePath, leaseSchema);
}

export function resolveLeaseDatabasePath(database: OpenClawStateLeaseDatabase): string {
  return database.schemaPolicy === "existing"
    ? path.resolve(database.options?.path ?? resolveOpenClawStateSqlitePath(database.options?.env))
    : openOpenClawStateDatabase(database.options).path;
}
export function readLeaseDatabase<T>(
  database: OpenClawStateLeaseDatabase,
  operation: (db: DatabaseSync) => T,
): T {
  return database.schemaPolicy === "existing"
    ? withOpenClawStateDatabaseReadOnly(({ db }) => operation(db), database.options)
    : operation(openOpenClawStateDatabase(database.options).db);
}
export function withLeaseWriteTransaction<T>(
  database: OpenClawStateLeaseDatabase,
  operationLabel: string,
  operation: (db: DatabaseSync) => T,
  busyTimeoutMs = 0,
): T {
  if (database.schemaPolicy === "existing") {
    return runExistingOpenClawStateWriteTransaction(
      ({ db }) => operation(db),
      database.options ?? {},
      { operationLabel, busyTimeoutMs, schemaSql: leaseSchema },
    );
  }
  const stateDatabase = openOpenClawStateDatabase(database.options);
  const run = () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => operation(db),
      { ...database.options, database: stateDatabase },
      { operationLabel, busyTimeoutMs },
    );
  return runWithSqliteBusyTimeout(stateDatabase.db, busyTimeoutMs, run);
}
