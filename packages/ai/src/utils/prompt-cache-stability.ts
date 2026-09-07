/**
 * Prompt-cache normalization helpers. They keep generated prompt sections
 * deterministic across platform newlines, trailing whitespace, and input
 * ordering.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeSurrogates } from "./sanitize-unicode.js";

/** Canonicalizes provider tool order without relying on host locale settings. */
export function sortPromptCacheToolsByName<
  T extends {
    readonly name?: string;
    readonly wireName?: string;
    readonly description?: string;
  },
>(tools: readonly T[]): T[] {
  const compareText = (left: string | undefined, right: string | undefined): number => {
    const leftText = left ?? "";
    const rightText = right ?? "";
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  };
  return tools.toSorted(
    (left, right) =>
      compareText(left.wireName ?? left.name, right.wireName ?? right.name) ||
      compareText(left.description, right.description),
  );
}

/** Normalize structured prompt text before hashing or snapshot comparison. */
export function normalizeStructuredPromptSection(text: string): string {
  return sanitizeSurrogates(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Normalize, de-dupe, and sort capability ids for stable prompt payloads. */
export function normalizePromptCapabilityIds(capabilities: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const capability of capabilities) {
    const value = normalizeLowercaseStringOrEmpty(normalizeStructuredPromptSection(capability));
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized.toSorted((left, right) => left.localeCompare(right));
}
