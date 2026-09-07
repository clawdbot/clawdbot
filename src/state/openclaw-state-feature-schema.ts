import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

/** Prepare canonical DDL without opening a database; each feature keeps its own handle cache. */
export function createOpenClawStateSchemaEnsurer(params: {
  table: string;
  endMarker?: string;
  operationLabel: string;
}): (options?: OpenClawStateDatabaseOptions) => void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    `\nCREATE TABLE IF NOT EXISTS ${params.table} (\n`,
  );
  const endMarker = params.endMarker ?? "\n) STRICT;\n";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start);
  if (start < 0 || end < start) {
    throw new Error(`Canonical state schema markers are missing for ${params.table}`);
  }
  const schema = OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + endMarker.length);
  const ensuredDatabases = new WeakSet<DatabaseSync>();
  return (options = {}) => {
    const database = openOpenClawStateDatabase(options);
    if (ensuredDatabases.has(database.db)) {
      return;
    }
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.exec(schema); // sqlite-allow-raw -- Canonical feature-local additive DDL only.
      },
      options,
      { operationLabel: params.operationLabel },
    );
    // Preserve successful wrapper-return timing, including nested savepoints.
    ensuredDatabases.add(database.db);
  };
}
