import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";
import {
  configureSqliteWalMaintenance,
  type SqliteWalMaintenance,
  type SqliteWalMaintenanceOptions,
} from "./sqlite-wal.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);
const sqliteWalMaintenanceByDb = new WeakMap<DatabaseSync, SqliteWalMaintenance>();

export function requireNodeSqlite(): typeof import("node:sqlite") {
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

export function configureMemorySqliteWalMaintenance(
  db: DatabaseSync,
  options?: SqliteWalMaintenanceOptions,
): SqliteWalMaintenance {
  const existing = sqliteWalMaintenanceByDb.get(db);
  if (existing) {
    return existing;
  }
  const maintenance = configureSqliteWalMaintenance(db, options);
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
