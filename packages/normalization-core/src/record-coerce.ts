/** Type guard for non-array object records at browser-safe boundaries. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Coerces object-like values to records, falling back to an empty record. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Reads a field only when it exists as a string. */
export function readStringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Returns a non-array record or undefined. */
export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Returns a non-array record or null. */
export function asNullableRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Returns any object-backed record, including arrays, or undefined. */
export function asOptionalObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Returns any object-backed record, including arrays, or null. */
export function asNullableObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
