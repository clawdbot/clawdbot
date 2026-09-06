import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const STORAGE_ERRORS = [
  ["SQLITE_BUSY", "database is locked", 5],
  ["SQLITE_LOCKED", "database table is locked", 6],
  ["SQLITE_READONLY", "attempt to write a readonly database", 8],
  ["SQLITE_IOERR", "disk I/O error", 10],
  ["SQLITE_FULL", "database or disk is full", 13],
  ["transcript_writer_fenced", "session writer claim changed before transcript persistence", -1],
] as const;
export type GatewayStorageFailure = (typeof STORAGE_ERRORS)[number][0];

/** Classify native errors before flattening; legacy rows require exact known messages. */
export function classifyGatewayStorageFailure(error: unknown): GatewayStorageFailure | undefined {
  const fields = typeof error === "string" ? { message: error } : isRecord(error) ? error : {};
  const code = fields.errorCode ?? fields.code;
  const nativeCode = fields.errcode;
  const primaryCode =
    typeof nativeCode === "number" && Number.isInteger(nativeCode) && nativeCode >= 0
      ? nativeCode & 0xff
      : undefined;
  const typed = STORAGE_ERRORS.find(
    ([name, , number]) =>
      primaryCode === number ||
      (typeof code === "string" &&
        (code === name || (name.startsWith("SQLITE_") && code.startsWith(`${name}_`)))),
  );
  return (typed ??
    STORAGE_ERRORS.find(([, message]) =>
      [fields.errstr, fields.errorMessage, fields.message].some(
        (value) => typeof value === "string" && value.trim() === message,
      ),
    ))?.[0];
}

export function formatSqliteErrorCodeSuffix(error: unknown): string {
  const details = new Set<string>();
  // Preserve native codes through wrappers without exposing cause prose or metadata.
  // The depth cap also bounds cyclic causes; Node's SQLite errcode is a signed int.
  for (let current = error, depth = 0; depth < 8 && isRecord(current); depth += 1) {
    const code = extractErrorCode(current);
    if (code && /^[A-Z0-9_]{1,64}$/u.test(code)) {
      details.add(`code=${code}`);
    }
    const { errcode } = current;
    if (
      typeof errcode === "number" &&
      Number.isInteger(errcode) &&
      errcode >= 0 &&
      errcode <= 0x7fff_ffff
    ) {
      details.add(`errcode=${errcode}`);
    }
    current = current.cause;
  }
  return details.size > 0 ? ` (${[...details].join(", ")})` : "";
}
