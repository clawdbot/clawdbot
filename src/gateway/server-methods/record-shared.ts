/**
 * Small normalization helpers shared by gateway request handlers.
 */
export { asOptionalRecord as asRecord } from "../../../packages/normalization-core/src/record-coerce.js";

/** Returns a non-empty trimmed string, or `undefined` for non-string input. */
export function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
