// Test helper for reading SQLite pragma state.
import type { DatabaseSync } from "node:sqlite";

// SQLite pragma test helpers normalize node:sqlite bigint/number outputs.
export type SqliteNumberPragma =
  | "auto_vacuum"
  | "busy_timeout"
  | "foreign_keys"
  | "schema_version"
  | "synchronous"
  | "user_version"
  | "wal_autocheckpoint";

/** Read a numeric SQLite pragma from a DatabaseSync instance. */
export function readSqliteNumberPragma(db: DatabaseSync, pragma: SqliteNumberPragma): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma] ?? row?.timeout;
  return typeof value === "bigint" ? Number(value) : Number(value);
}
