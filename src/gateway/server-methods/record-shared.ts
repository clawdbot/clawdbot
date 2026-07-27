/**
 * Small normalization helpers shared by gateway request handlers.
 */
/** Returns a non-empty trimmed string, or `undefined` for non-string input. */
export function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
