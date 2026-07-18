import type { DatabaseSync } from "node:sqlite";

type SqliteIntegrityChecks = {
  integrityCheck: "ok";
};

type SqliteCheckPragma = "integrity_check";
type SqliteForeignKeyViolation = {
  fkid: bigint;
  parent: string;
  rowid: bigint | null;
  table: string;
};

const MAX_REPORTED_FOREIGN_KEY_VIOLATIONS = 5;

const SQLITE_CORRUPT_ERRCODE = 11;
const SQLITE_NOTADB_ERRCODE = 26;

/** Return whether a named integrity failure proves persistent database damage. */
export function isTerminalSqliteIntegrityError(error: Error): boolean {
  if (error.name !== "SqliteIntegrityError") {
    return false;
  }
  const cause = error.cause as { errcode?: unknown } | undefined;
  if (!cause) {
    // No cause means the check pragma itself reported corruption rows: persistent.
    return true;
  }
  if (typeof cause.errcode !== "number") {
    return false;
  }
  // Mask extended codes to the primary; transient lock/busy failures must not latch.
  const primaryCode = cause.errcode & 0xff;
  return primaryCode === SQLITE_CORRUPT_ERRCODE || primaryCode === SQLITE_NOTADB_ERRCODE;
}

/** Require structural, table/index, and referential consistency before trusting a database. */
export function assertSqliteIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
): SqliteIntegrityChecks {
  const integrityCheck = runSqliteCheck(database, databaseLabel, "integrity_check");
  runSqliteForeignKeyCheck(database, databaseLabel);
  return { integrityCheck };
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
  let rows: Array<Record<string, unknown>>;
  try {
    rows = database.prepare(`PRAGMA ${pragma}${argument};`).all() as Array<Record<string, unknown>>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createSqliteIntegrityError(
      `SQLite ${pragma} failed for ${databaseLabel}: ${message}`,
      error,
    );
  }
  const results = rows.map((row) => row[pragma] ?? Object.values(row)[0]);
  if (results.length === 1 && results[0] === "ok") {
    return "ok";
  }
  const details = results.map((result) => String(result)).join("; ") || "no result";
  throw createSqliteIntegrityError(`SQLite ${pragma} failed for ${databaseLabel}: ${details}`);
}

function runSqliteForeignKeyCheck(database: DatabaseSync, databaseLabel: string): void {
  let violationCount = 0;
  const violations: SqliteForeignKeyViolation[] = [];
  try {
    // Use direct PRAGMA syntax because a real schema object can shadow the
    // table-valued pragma name and make a corrupt database appear clean.
    const statement = database.prepare("PRAGMA foreign_key_check;");
    statement.setReadBigInts(true);
    // OpenClaw's Node >=22.22.3 floor includes iterate(), added in Node 22.13.
    for (const violation of statement.iterate() as Iterable<SqliteForeignKeyViolation>) {
      violationCount += 1;
      retainSortedForeignKeyViolation(violations, violation);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createSqliteIntegrityError(
      `SQLite foreign_key_check failed for ${databaseLabel}: ${message}`,
      error,
    );
  }
  if (violations.length === 0) {
    return;
  }

  const details = violations.map(formatSqliteForeignKeyViolation);
  if (violationCount > MAX_REPORTED_FOREIGN_KEY_VIOLATIONS) {
    details.push("additional violations omitted");
  }
  throw createSqliteIntegrityError(
    `SQLite foreign_key_check failed for ${databaseLabel}: ${details.join("; ")}`,
  );
}

function createSqliteIntegrityError(message: string, cause?: unknown): Error {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.name = "SqliteIntegrityError";
  return error;
}

function retainSortedForeignKeyViolation(
  retained: SqliteForeignKeyViolation[],
  violation: SqliteForeignKeyViolation,
): void {
  retained.push(violation);
  retained.sort(compareSqliteForeignKeyViolations);
  if (retained.length > MAX_REPORTED_FOREIGN_KEY_VIOLATIONS) {
    retained.pop();
  }
}

function compareSqliteForeignKeyViolations(
  left: SqliteForeignKeyViolation,
  right: SqliteForeignKeyViolation,
): number {
  const tableOrder = Buffer.compare(Buffer.from(left.table), Buffer.from(right.table));
  if (tableOrder !== 0) {
    return tableOrder;
  }
  if (left.rowid === null || right.rowid === null) {
    if (left.rowid !== right.rowid) {
      return left.rowid === null ? -1 : 1;
    }
  } else if (left.rowid !== right.rowid) {
    return left.rowid < right.rowid ? -1 : 1;
  }
  const parentOrder = Buffer.compare(Buffer.from(left.parent), Buffer.from(right.parent));
  if (parentOrder !== 0) {
    return parentOrder;
  }
  if (left.fkid === right.fkid) {
    return 0;
  }
  return left.fkid < right.fkid ? -1 : 1;
}

function formatSqliteForeignKeyViolation(violation: SqliteForeignKeyViolation): string {
  const row = violation.rowid === null ? "row without rowid" : `row ${violation.rowid.toString()}`;
  return `${violation.table} ${row} references ${violation.parent} (foreign key ${violation.fkid.toString()})`;
}
