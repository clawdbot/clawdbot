// Tiny shared value-normalization helpers for script JSON records.
/**
 * Return whether a value is a plain non-array object record.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Trim string values while converting non-strings to an empty string.
 * @param {unknown} value
 * @returns {string}
 */
export function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}
