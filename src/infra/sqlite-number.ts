const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function coerceRequiredSqliteNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/** Converts a SQLite number or safely representable bigint column into a JavaScript number. */
export function normalizeSqliteNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    if (value > MAX_SAFE_INTEGER_BIGINT || value < -MAX_SAFE_INTEGER_BIGINT) {
      return undefined;
    }
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}
