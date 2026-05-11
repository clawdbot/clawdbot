/**
 * String normalization and record-coercion helpers.
 *
 * These are self-contained re-implementations of the functions that
 * the plugin previously imported from broad SDK text barrels
 * and shared record/string coercion helpers.
 *
 * core/ modules use these instead of importing plugin-sdk, keeping the
 * shared layer portable between the built-in and standalone versions.
 */

// ---- String coercion ----

/** Return the trimmed string or `null` when the value is not a non-empty string. */
function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Return the trimmed string or `undefined` when the value is not a non-empty string. */
export function normalizeOptionalString(value: unknown): string | undefined {
  return normalizeNullableString(value) ?? undefined;
}

/**
 * Stringify then normalize.  Accepts `string | number | boolean | bigint`.
 * Returns `undefined` for objects, arrays, null, and undefined.
 */
export function normalizeStringifiedOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return normalizeOptionalString(String(value));
  }
  return undefined;
}

/** Return the trimmed lowercase string or `undefined`. */
export function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase();
}

/** Return the trimmed lowercase string or `""`. */
export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

// ---- Record coercion ----

/** Coerce a value into a `Record<string, unknown>` or `undefined`. */
export function asOptionalObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Read a string field from a record. */
export function readStringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const v = record?.[key];
  return typeof v === "string" ? v : undefined;
}

// ---- Filename normalization ----

/**
 * Normalize filenames into a UTF-8 form that the QQ Bot API accepts reliably.
 *
 * Decodes percent-escaped names, converts Unicode to NFC, and strips
 * ASCII control characters.
 */
export function sanitizeFileName(name: string): string {
  if (!name) {
    return name;
  }
  let result = name.trim();
  if (result.includes("%")) {
    try {
      result = decodeURIComponent(result);
    } catch {
      // Keep the raw value if it is not valid percent-encoding.
    }
  }
  result = result.normalize("NFC");
  result = result.replace(/\p{Cc}/gu, "");
  return result;
}
