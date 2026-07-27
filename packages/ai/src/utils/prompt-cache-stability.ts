/**
 * Prompt-cache normalization helpers. They keep generated prompt sections
 * deterministic across platform newlines, trailing whitespace, and input
 * ordering.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeSurrogates } from "./sanitize-unicode.js";

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
