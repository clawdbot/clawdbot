// Shared terminal string normalization helpers.

/** Normalize string input to lowercase, returning empty string for non-strings. */
export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}
