// Classifies SQLite failures without loading transaction or logging infrastructure.

const SQLITE_LOCK_ERROR_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);
// Node reports SQLite failures with a generic string code and the extended
// SQLite result in `errcode`; the low byte identifies the primary result.
const SQLITE_BUSY_RESULT_CODE = 5;
const SQLITE_LOCKED_RESULT_CODE = 6;
const SQLITE_CORRUPT_RESULT_CODE = 11;
const SQLITE_NOTADB_RESULT_CODE = 26;
const SQLITE_PRIMARY_RESULT_CODE_MASK = 0xff;

function sqliteErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function sqliteExtendedResultCode(error: unknown): number | undefined {
  const errcode =
    error && typeof error === "object" ? (error as { errcode?: unknown }).errcode : undefined;
  return typeof errcode === "number" && Number.isInteger(errcode) ? errcode : undefined;
}

function sqlitePrimaryResultCode(error: unknown): number | undefined {
  const errcode = sqliteExtendedResultCode(error);
  return errcode === undefined ? undefined : errcode & SQLITE_PRIMARY_RESULT_CODE_MASK;
}

export function isSqliteLockError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code !== undefined && SQLITE_LOCK_ERROR_CODES.has(code)) {
    return true;
  }
  const primaryCode = sqlitePrimaryResultCode(error);
  return primaryCode === SQLITE_BUSY_RESULT_CODE || primaryCode === SQLITE_LOCKED_RESULT_CODE;
}

/** Report proven file damage (corrupt page or non-database header), not transient failure. */
export function isSqliteCorruptionError(error: unknown): boolean {
  const primaryCode = sqlitePrimaryResultCode(error);
  return primaryCode === SQLITE_CORRUPT_RESULT_CODE || primaryCode === SQLITE_NOTADB_RESULT_CODE;
}

export function readSqliteErrorDetails(error: unknown): {
  code: string | undefined;
  extendedCode: number | undefined;
  primaryCode: number | undefined;
} {
  return {
    code: sqliteErrorCode(error),
    extendedCode: sqliteExtendedResultCode(error),
    primaryCode: sqlitePrimaryResultCode(error),
  };
}
