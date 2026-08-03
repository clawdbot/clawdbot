// Memory Host SDK module implements sqlite behavior.
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";
import { installProcessWarningFilter } from "./openclaw-runtime-io.js";
import {
  configureSqliteConnectionPragmas,
  configureSqliteWalMaintenance,
  type SqliteConnectionPragmaOptions,
  type SqliteWalMaintenance,
  type SqliteWalMaintenanceOptions,
} from "./sqlite-wal.js";

const require = createRequire(import.meta.url);
const sqliteWalMaintenanceByDb = new WeakMap<DatabaseSync, SqliteWalMaintenance>();

function requireMemoryHostNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = formatErrorMessage(err);
    // Node distributions can ship without the experimental builtin SQLite module.
    // Surface an actionable error instead of the generic "unknown builtin module".
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}

export { requireMemoryHostNodeSqlite as requireNodeSqlite };

export function configureMemorySqliteWalMaintenance(
  db: DatabaseSync,
  options?: SqliteWalMaintenanceOptions & Pick<SqliteConnectionPragmaOptions, "busyTimeoutMs">,
): SqliteWalMaintenance {
  const existing = sqliteWalMaintenanceByDb.get(db);
  if (existing) {
    return existing;
  }
  const maintenance =
    options?.busyTimeoutMs === undefined
      ? configureSqliteWalMaintenance(db, options)
      : configureSqliteConnectionPragmas(db, options);
  sqliteWalMaintenanceByDb.set(db, maintenance);
  return maintenance;
}

export function closeMemorySqliteWalMaintenance(db: DatabaseSync): boolean {
  const maintenance = sqliteWalMaintenanceByDb.get(db);
  if (!maintenance) {
    return true;
  }
  sqliteWalMaintenanceByDb.delete(db);
  return maintenance.close();
}
