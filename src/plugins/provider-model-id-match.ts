import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** True when an id matches a normalized exact value or value prefix. */
export function matchesExactOrPrefix(id: string, values: readonly string[]): boolean {
  const normalizedId = normalizeLowercaseStringOrEmpty(id);
  return values.some((value) => {
    const normalizedValue = normalizeLowercaseStringOrEmpty(value);
    return normalizedId === normalizedValue || normalizedId.startsWith(normalizedValue);
  });
}
