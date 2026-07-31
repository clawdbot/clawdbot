// Shared string normalization helpers for media-generation packages.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Return unique trimmed strings while preserving first-seen order. */
export function uniqueTrimmedStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
