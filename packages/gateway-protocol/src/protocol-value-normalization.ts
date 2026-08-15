/** Narrows untrusted protocol values to non-array records. */
export function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Converts untrusted protocol values to records without accepting arrays. */
export function asProtocolRecord(value: unknown): Record<string, unknown> | null {
  return isProtocolRecord(value) ? value : null;
}

/** Checks string presence without changing wire-significant whitespace. */
export function isNonEmptyProtocolString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Trims an optional untrusted string and rejects empty results. */
export function normalizeOptionalProtocolString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
