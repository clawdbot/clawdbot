/** Reads a value only when it is already a string, preserving whitespace. */
export function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Trims string input and returns null for non-strings or empty strings. */
export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Trims string input and returns undefined for non-strings or empty strings. */
export function normalizeOptionalString(value: unknown): string | undefined {
  return normalizeNullableString(value) ?? undefined;
}

/** Trims bounded string input and rejects blank, non-string, or overlong values. */
export function normalizeBoundedOptionalString(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (!Number.isInteger(maxLength) || maxLength < 0) {
    return undefined;
  }
  const normalized = normalizeOptionalString(value);
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

/** Requires non-blank string input while preserving its original whitespace. */
export function readNonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Rejects only empty or non-string values while preserving whitespace. */
export function readNonEmptyStringPreservingWhitespace(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Stringifies primitive ids/flags before applying optional string normalization. */
export function normalizeStringifiedOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return normalizeOptionalString(String(value));
  }
  return undefined;
}

/** Normalizes an optional array of primitive-ish values into non-empty strings. */
export function normalizeStringifiedEntries(values?: ReadonlyArray<unknown>): string[] {
  return (values ?? [])
    .map((entry) => normalizeStringifiedOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/** Lowercases a normalized optional string. */
export function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase();
}

/** Lowercases a normalized string or returns an empty string when absent. */
export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

export type FastMode = boolean | "auto";

/** Parses loose boolean/fast-mode flags from strings or booleans. */
export function normalizeFastMode(raw?: unknown): FastMode | undefined {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  if (["off", "false", "no", "0", "disable", "disabled", "normal"].includes(key)) {
    return false;
  }
  if (["on", "true", "yes", "1", "enable", "enabled", "fast"].includes(key)) {
    return true;
  }
  if (["auto", "automatic"].includes(key)) {
    return "auto";
  }
  return undefined;
}

/** Lowercases text while intentionally preserving surrounding whitespace. */
export function lowercasePreservingWhitespace(value: string): string {
  return value.toLowerCase();
}

/** Locale-aware lowercase helper that still preserves surrounding whitespace. */
export function localeLowercasePreservingWhitespace(value: string): string {
  return value.toLocaleLowerCase();
}

/** Reads a string directly or from an object's `primary` field. */
export function resolvePrimaryStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString((value as { primary?: unknown }).primary);
}

/** Normalizes thread ids that may be numeric or string-backed. */
export function normalizeOptionalThreadValue(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  return normalizeOptionalString(value);
}

/** Normalizes a thread/id value and stringifies finite numeric ids. */
export function normalizeOptionalStringifiedId(value: unknown): string | undefined {
  const normalized = normalizeOptionalThreadValue(value);
  return normalized == null ? undefined : String(normalized);
}

/** Type guard for strings that remain non-empty after trimming. */
export function hasNonEmptyString(value: unknown): value is string {
  return normalizeOptionalString(value) !== undefined;
}
