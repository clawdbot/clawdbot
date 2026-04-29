import { normalizeOptionalLowercaseString, normalizeOptionalString } from "./string-coerce.js";

export function normalizeStringEntries(list?: ReadonlyArray<unknown>) {
  return (list ?? []).map((entry) => normalizeOptionalString(String(entry)) ?? "").filter(Boolean);
}

export function normalizeStringEntriesLower(list?: ReadonlyArray<unknown>) {
  return normalizeStringEntries(list).map((entry) => normalizeOptionalLowercaseString(entry) ?? "");
}

export function normalizeTrimmedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const normalized = normalizeOptionalString(entry);
    return normalized ? [normalized] : [];
  });
}

export function normalizeOptionalTrimmedStringList(value: unknown): string[] | undefined {
  const normalized = normalizeTrimmedStringList(value);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeArrayBackedTrimmedStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return normalizeTrimmedStringList(value);
}

export function normalizeSingleOrTrimmedStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeTrimmedStringList(value);
  }
  const normalized = normalizeOptionalString(value);
  return normalized ? [normalized] : [];
}

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
  return (normalizeOptionalLowercaseString(raw) ?? "").normalize("NFC");
}

export function normalizeHyphenSlug(raw?: string | null) {
  const trimmed = normalizeSlugInput(raw);
  if (!trimmed) {
    return "";
  }
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^\p{L}\p{M}\p{N}#@._+-]+/gu, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

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
