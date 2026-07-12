import type { DatabaseSync } from "node:sqlite";

export type SqliteIntegrityChecks = {
  integrityCheck: "ok";
  quickCheck: "ok";
};

type SqliteCheckPragma = "integrity_check" | "quick_check";

/** Require both structural and table/index consistency before trusting a database. */
export function assertSqliteIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
): SqliteIntegrityChecks {
  return {
    quickCheck: runSqliteCheck(database, databaseLabel, "quick_check"),
    integrityCheck: runSqliteCheck(database, databaseLabel, "integrity_check"),
  };
}

/** Require table and associated index consistency before trusting indexed reads. */
export function assertSqliteTableIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
  tableName: string,
): void {
  runSqliteCheck(database, `${databaseLabel} table ${tableName}`, "integrity_check", tableName);
}

function runSqliteCheck(
  database: DatabaseSync,
  databaseLabel: string,
  pragma: SqliteCheckPragma,
  tableName?: string,
): "ok" {
  const argument = tableName ? `('${tableName.replaceAll("'", "''")}')` : "";
  const rows = database.prepare(`PRAGMA ${pragma}${argument};`).all() as Array<
    Record<string, unknown>
  >;
  const results = rows.map((row) => row[pragma] ?? Object.values(row)[0]);
  if (results.length === 1 && results[0] === "ok") {
    return "ok";
  }
  const details = results.map((result) => String(result)).join("; ") || "no result";
  throw new Error(`SQLite ${pragma} failed for ${databaseLabel}: ${details}`);
}
