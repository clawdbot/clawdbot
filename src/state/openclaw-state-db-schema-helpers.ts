// Provides shared SQLite schema probes and table migration helpers.
import type { DatabaseSync } from "node:sqlite";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";

export function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  return tableHasColumns(db, tableName, [columnName]);
}

export function tableHasColumns(
  db: DatabaseSync,
  tableName: string,
  columnNames: readonly string[],
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  const existing = new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  return columnNames.every((columnName) => existing.has(columnName));
}

export function tablePrimaryKeyColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: unknown;
    pk?: unknown;
  }>;
  return rows
    .filter((row) => Number(row.pk ?? 0) > 0 && typeof row.name === "string")
    .toSorted((left, right) => Number(left.pk ?? 0) - Number(right.pk ?? 0))
    .map((row) => row.name as string);
}

export function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

export function ensureColumn(db: DatabaseSync, tableName: string, columnSql: string): boolean {
  const columnName = columnSql.trim().split(/\s+/, 1)[0];
  if (!columnName || !tableExists(db, tableName) || tableHasColumn(db, tableName, columnName)) {
    return false;
  }
  // State migrations are additive here; destructive or shape-changing repairs belong in doctor.
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql};`);
  return true;
}

export function rebuildCanonicalStateTable(
  db: DatabaseSync,
  tableName: string,
  version: number,
  schemaSql: string,
): void {
  const migrationTable = `${tableName}_migration_v${version}`;
  if (tableExists(db, migrationTable)) {
    throw new Error(`OpenClaw v${version} migration table already exists: ${migrationTable}`);
  }
  const startMarker = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
  const start = schemaSql.indexOf(startMarker);
  const endMarker = "\n) STRICT;";
  const end = start >= 0 ? schemaSql.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) {
    throw new Error(`Canonical ${tableName} schema block is missing`);
  }
  const migrationSchema = schemaSql
    .slice(start, end + endMarker.length)
    .replace(startMarker, `CREATE TABLE ${migrationTable} (`);
  db.exec(migrationSchema);
  const columns = db
    .prepare(`PRAGMA table_xinfo(${migrationTable})`)
    .all()
    .flatMap((column) =>
      column.hidden === 0 && typeof column.name === "string"
        ? [quoteSqliteIdentifier(column.name)]
        : [],
    )
    .join(", ");
  db.exec(`INSERT INTO ${migrationTable} (${columns}) SELECT ${columns} FROM ${tableName};`);
  db.exec(`DROP TABLE ${tableName};`);
  db.exec(`ALTER TABLE ${migrationTable} RENAME TO ${tableName};`);
}
