/**
 * Small record/string coercion helpers shared by Browser setup and audits.
 */
import {
  asNullableRecord,
  hasNonEmptyString as sharedHasNonEmptyString,
  isRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";

/** Re-export record guards under Browser-local names. */
export { asNullableRecord as asRecord, isRecord };

/** Re-export shared non-empty string predicate. */
export const hasNonEmptyString = sharedHasNonEmptyString;

/** Normalizes primitive string/number/boolean values to non-empty strings. */
export function normalizeString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}
