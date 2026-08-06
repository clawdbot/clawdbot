// Shared CLI timeout parsers for millisecond flags and config-backed fallbacks.
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";

/** Parse a positive millisecond timeout, returning undefined for absent or invalid input. */
export function parseTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  let value = Number.NaN;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "bigint") {
    value = Number(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    return parseStrictPositiveInteger(trimmed);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function invalidTimeout(value?: string): Error {
  const suffix = value ? ` Received: "${value}".` : "";
  return new Error(
    `Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000.${suffix}`,
  );
}

/** Parse a positive timeout or return the supplied fallback for missing values. */
export function parseTimeoutMsWithFallback(
  raw: unknown,
  fallbackMs: number,
  options: {
    invalidType?: "fallback" | "error";
  } = {},
): number {
  if (raw === undefined || raw === null) {
    return fallbackMs;
  }

  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? String(raw)
        : null;

  if (value === null) {
    if (options.invalidType === "error") {
      throw invalidTimeout();
    }
    return fallbackMs;
  }

  if (!value) {
    if (options.invalidType === "error") {
      throw invalidTimeout();
    }
    return fallbackMs;
  }

  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw invalidTimeout(value);
  }
  return parsed;
}
