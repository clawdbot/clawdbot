/**
 * Shared metric extraction helpers for Talk event diagnostics and logging.
 *
 * Talk event payloads are provider-owned JSON blobs, so callers must coerce
 * records and read only bounded numeric counters that are safe to export.
 */
/** Coerce unknown Talk event payloads into optional records for metric reads. */
export { asOptionalRecord as talkEventPayloadRecord } from "../../packages/normalization-core/src/record-coerce.js";

/** Read the first non-negative finite number from a provider payload record. */
export function firstFiniteTalkEventNumber(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      // Reject negative, NaN, and Infinity values before diagnostics/logging so
      // provider bugs cannot poison aggregate Talk metrics.
      return value;
    }
  }
  return undefined;
}
