// Parses byte-size config values for logging and retention limits.
import { parseByteSize } from "../cli/parse-bytes.js";

/**
 * Parse an optional byte-size value from config.
 * Accepts non-negative numbers or strings like "2mb".
 */
export function parseNonNegativeByteSize(value: unknown): number | null {
  if (typeof value === "number") {
    const int = Math.floor(value);
    return Number.isSafeInteger(int) && int >= 0 ? int : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      // Bare numbers in config strings are bytes, matching numeric config values.
      const bytes = parseByteSize(trimmed, { defaultUnit: "b" });
      return bytes >= 0 ? bytes : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Validates byte-size strings accepted by agent default byte-threshold config. */
export function isValidNonNegativeByteSizeString(value: string): boolean {
  return parseNonNegativeByteSize(value) !== null;
}
