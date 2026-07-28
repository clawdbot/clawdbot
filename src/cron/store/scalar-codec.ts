import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";

/** Parses a JSON object column, returning the fallback for malformed or non-object values. */
export function parseJsonObject<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Parses a JSON column without shape validation, returning the fallback only on parse failure. */
export function parseJsonValue<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Normalizes SQLite number/bigint columns into JavaScript numbers. */
export { normalizeSqliteNumber as normalizeNumber };

/** Converts optional booleans into nullable SQLite integer flags. */
export function booleanToInteger(value: boolean | undefined): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

/** Converts SQLite integer flags into booleans while preserving missing columns as undefined. */
export function integerToBoolean(value: number | bigint | null): boolean | undefined {
  const normalized = normalizeSqliteNumber(value);
  return normalized == null ? undefined : normalized !== 0;
}

/** Serializes optional structured values for JSON columns. */
export function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

/** Parses a JSON string-array column and drops non-string entries from legacy data. */
export function parseJsonArray(raw: string | null): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = parseJsonObject<unknown>(raw, undefined);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : undefined;
}
