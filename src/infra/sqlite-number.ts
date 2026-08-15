const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

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
