import type { DatabaseSync } from "node:sqlite";

export type SqliteNumberPragma =
  | "busy_timeout"
  | "foreign_keys"
  | "synchronous"
  | "user_version"
  | "wal_autocheckpoint";

export function readSqliteNumberPragma(db: DatabaseSync, pragma: SqliteNumberPragma): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma] ?? row?.timeout;
  return typeof value === "bigint" ? Number(value) : Number(value);
}
