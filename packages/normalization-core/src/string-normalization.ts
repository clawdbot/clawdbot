import { normalizeOptionalLowercaseString, normalizeOptionalString } from "./string-coerce.js";

/** Coerces entries to strings, trims them, and drops empty results. */
export function normalizeStringEntries(list?: ReadonlyArray<unknown>) {
  return (list ?? []).map((entry) => normalizeOptionalString(String(entry)) ?? "").filter(Boolean);
}

/** Normalizes string entries and lowercases each retained value. */
export function normalizeStringEntriesLower(list?: ReadonlyArray<unknown>) {
  return normalizeStringEntries(list).map((entry) => normalizeOptionalLowercaseString(entry) ?? "");
}

/** Returns first-seen unique values while preserving insertion order. */
export function uniqueValues<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Returns first-seen unique strings while preserving insertion order. */
export function uniqueStrings(values: Iterable<string>): string[] {
  return uniqueValues(values);
}

/** Returns unique strings sorted with stable ASCII comparison. */
export function sortUniqueStrings(values: Iterable<string>): string[] {
  return uniqueStrings(values).toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** Normalizes entries, removes duplicates, and preserves first-seen order. */
export function normalizeUniqueStringEntries(values?: Iterable<unknown>): string[] {
  return uniqueStrings(normalizeStringEntries(values ? [...values] : undefined));
}

/** Lowercases normalized entries, removes empties/duplicates, and preserves first-seen order. */
export function normalizeUniqueStringEntriesLower(values?: Iterable<unknown>): string[] {
  return uniqueStrings(
    normalizeStringEntriesLower(values ? [...values] : undefined).filter(Boolean),
  );
}

/** Normalizes entries, removes duplicates, and returns sorted output. */
export function normalizeSortedUniqueStringEntries(values?: Iterable<unknown>): string[] {
  return sortUniqueStrings(normalizeUniqueStringEntries(values));
}

/** Normalizes array-backed string lists and rejects non-array input as empty. */
export function normalizeTrimmedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const normalized = normalizeOptionalString(entry);
    return normalized ? [normalized] : [];
  });
}

/** Normalizes an array-backed string list and removes duplicates. */
export function normalizeUniqueTrimmedStringList(value: unknown): string[] {
  return uniqueStrings(normalizeTrimmedStringList(value));
}

/** Normalizes an array-backed string list, removes duplicates, and sorts it. */
export function normalizeSortedUniqueTrimmedStringList(value: unknown): string[] {
  return sortUniqueStrings(normalizeTrimmedStringList(value));
}

/** Returns undefined instead of an empty normalized array-backed string list. */
export function normalizeOptionalTrimmedStringList(value: unknown): string[] | undefined {
  const normalized = normalizeTrimmedStringList(value);
  return normalized.length > 0 ? normalized : undefined;
}

/** Returns undefined for non-arrays but preserves an empty array for explicit arrays. */
export function normalizeArrayBackedTrimmedStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return normalizeTrimmedStringList(value);
}

/** Normalizes either a single string-like value or an array-backed string list. */
export function normalizeSingleOrTrimmedStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeTrimmedStringList(value);
  }
  const normalized = normalizeOptionalString(value);
  return normalized ? [normalized] : [];
}

/** Normalizes single-or-array string input and removes duplicates. */
export function normalizeUniqueSingleOrTrimmedStringList(value: unknown): string[] {
  return uniqueStrings(normalizeSingleOrTrimmedStringList(value));
}

/** Parses either array entries or comma-separated string entries into trimmed values. */
export function normalizeCsvOrLooseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeStringEntries(value);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeSlugInput(raw?: string | null) {
  // NFC keeps visually identical composed/decomposed Unicode labels matching the
  // same slug while preserving non-Latin channel and room names.
  return (normalizeOptionalLowercaseString(raw) ?? "").normalize("NFC");
}

/** Normalizes user-facing names into permissive lowercase slugs that may keep #/@/._+. */
export function normalizeHyphenSlug(raw?: string | null) {
  const trimmed = normalizeSlugInput(raw);
  if (!trimmed) {
    return "";
  }
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^\p{L}\p{M}\p{N}#@._+-]+/gu, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

/** Normalizes @/#-prefixed channel names into strict lowercase hyphen slugs without the prefix. */
export function normalizeAtHashSlug(raw?: string | null) {
  const trimmed = normalizeSlugInput(raw);
  if (!trimmed) {
    return "";
  }
  const withoutPrefix = trimmed.replace(/^[@#]+/, "");
  const dashed = withoutPrefix.replace(/[\s_]+/g, "-");
  const cleaned = dashed.replace(/[^\p{L}\p{M}\p{N}-]+/gu, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}
