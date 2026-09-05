import type { DatabaseSync } from "node:sqlite";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "./sqlite-file-generation.js";
import { isSqliteCorruptionError } from "./sqlite-transaction.js";

type SqliteIntegrityChecks = {
  integrityCheck: "ok";
};

export type SqliteIntegrityOperation<T> = Generator<
  { database: DatabaseSync; databaseLabel: string },
  T,
  void
>;

/** Run the same admission steps synchronously when the caller cannot yield. */
export function runSqliteIntegrityOperationSync<T>(operation: SqliteIntegrityOperation<T>): T {
  let step = operation.next();
  while (!step.done) {
    try {
      assertSqliteIntegrity(step.value.database, step.value.databaseLabel);
    } catch (error) {
      step = operation.throw(error);
      continue;
    }
    step = operation.next();
  }
  return step.value;
}

type UnboundSqliteIntegrityConfirmation =
  | { status: "failed"; error: Error; terminal: boolean }
  | { status: "healthy" };

export type SqliteIntegrityConfirmation =
  | { status: "failed"; error: Error; terminal: false }
  | { status: "failed"; error: Error; generation: SqliteFileGeneration; terminal: true }
  | { status: "healthy"; generation: SqliteFileGeneration };

type SqliteCheckPragma = "integrity_check";
type SqliteForeignKeyViolation = {
  fkid: bigint;
  parent: string;
  rowid: bigint | null;
  table: string;
};

const MAX_REPORTED_FOREIGN_KEY_VIOLATIONS = 5;

/** Return whether a named integrity failure proves persistent database damage. */
export function isTerminalSqliteIntegrityError(error: Error): boolean {
  if (error.name !== "SqliteIntegrityError") {
    return false;
  }
  if (!error.cause) {
    // No cause means the check pragma itself reported corruption rows: persistent.
    return true;
  }
  // Only proven corruption latches; transient lock/busy pragma failures must not.
  return isSqliteCorruptionError(error.cause);
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

/** Run integrity checks and preserve whether a failure proves persistent damage. */
function confirmSqliteIntegrity(
  database: DatabaseSync,
  databaseLabel: string,
): UnboundSqliteIntegrityConfirmation {
  try {
    assertSqliteIntegrity(database, databaseLabel);
    return { status: "healthy" };
  } catch (error) {
    return failedSqliteIntegrityConfirmation(error);
  }
}

/** Reconfirm an advisory failure against the database currently at a closed path. */
export function confirmSqliteFileIntegrity(
  pathname: string,
  databaseLabel: string,
): SqliteIntegrityConfirmation {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let initial: SqliteFileGeneration;
    try {
      initial = readStableSqliteFileGeneration(pathname);
    } catch (error) {
      return unboundSqliteIntegrityFailure(error);
    }

    let database: DatabaseSync;
    try {
      database = openNodeSqliteDatabase(pathname, { readOnly: true });
    } catch (error) {
      // A failed SQLite open exposes no descriptor identity. Path snapshots
      // cannot bind the error safely across an A -> B -> A file rotation.
      return unboundSqliteIntegrityFailure(error);
    }

    let opened: SqliteFileGeneration;
    try {
      opened = readStableSqliteFileGeneration(pathname);
    } catch {
      const closeError = closeSqliteDatabase(database);
      if (closeError) {
        return unboundSqliteIntegrityFailure(closeError);
      }
      continue;
    }
    if (!sameSqliteFileGeneration(initial, opened)) {
      const closeError = closeSqliteDatabase(database);
      if (closeError) {
        return unboundSqliteIntegrityFailure(closeError);
      }
      continue;
    }

    let confirmation = confirmSqliteIntegrity(database, databaseLabel);
    const closeError = closeSqliteDatabase(database);
    if (closeError && confirmation.status === "healthy") {
      confirmation = failedSqliteIntegrityConfirmation(closeError);
    }

    let final: SqliteFileGeneration;
    try {
      final = readStableSqliteFileGeneration(pathname);
    } catch {
      continue;
    }
    if (!sameSqliteFileGeneration(opened, final)) {
      continue;
    }
    return bindSqliteIntegrityConfirmation(confirmation, final);
  }
  return unboundSqliteIntegrityFailure(
    new Error(`SQLite file generation did not stabilize during confirmation: ${pathname}`),
  );
}

function bindSqliteIntegrityConfirmation(
  confirmation: UnboundSqliteIntegrityConfirmation,
  generation: SqliteFileGeneration,
): SqliteIntegrityConfirmation {
  if (confirmation.status === "healthy") {
    return { status: "healthy", generation };
  }
  if (confirmation.terminal) {
    return { ...confirmation, generation, terminal: true };
  }
  return { ...confirmation, terminal: false };
}

function failedSqliteIntegrityConfirmation(error: unknown): UnboundSqliteIntegrityConfirmation {
  const normalized = toStringifiedError(error);
  return {
    status: "failed",
    error: normalized,
    terminal: isTerminalSqliteIntegrityError(normalized),
  };
}

function unboundSqliteIntegrityFailure(error: unknown): SqliteIntegrityConfirmation {
  const normalized = toStringifiedError(error);
  return { status: "failed", error: normalized, terminal: false };
}

function closeSqliteDatabase(database: DatabaseSync): Error | undefined {
  try {
    database.close();
    return undefined;
  } catch (error) {
    return toStringifiedError(error);
  }
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
