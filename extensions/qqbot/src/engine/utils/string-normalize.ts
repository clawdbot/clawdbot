/**
 * String normalization and record-coercion helpers.
 *
 * These are self-contained re-implementations of the functions that
 * the plugin previously imported from `openclaw/plugin-sdk/text-runtime`
 * and `openclaw/plugin-sdk/text-runtime` (via record-coerce / string-coerce).
 *
 * core/ modules use these instead of importing plugin-sdk, keeping the
 * shared layer portable between the built-in and standalone versions.
 */

// ---- String coercion ----

/** Return the trimmed string or `null` when the value is not a non-empty string. */
export function normalizeNullableString(value: unknown): string | null {
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

/** Return the raw string value or `undefined`. No trimming. */
export function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Return true when the value is a non-empty trimmed string. */
export function hasNonEmptyString(value: unknown): value is string {
  return normalizeOptionalString(value) !== undefined;
}

// ---- Record coercion ----

/** Coerce a value into a `Record<string, unknown>`, defaulting to `{}`. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

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

/** Read a number field from a record. */
export function readNumberField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const v = record?.[key];
  return typeof v === "number" ? v : undefined;
}

/** Read a boolean field from a record. */
export function readBooleanField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): boolean | undefined {
  const v = record?.[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Coerce a value into a string→string map, filtering out non-string values. */
export function readStringMap(value: unknown): Record<string, string> {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, entryValue]) =>
      typeof entryValue === "string" ? [[key, entryValue]] : [],
    ),
  );
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
