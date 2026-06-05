// Tiny shared value-normalization helpers for script JSON records.
/** Return whether a value is a plain non-array object record. */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Trim string values while converting non-strings to an empty string. */
export function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}
