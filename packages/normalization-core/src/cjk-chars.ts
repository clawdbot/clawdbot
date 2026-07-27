/**
 * Shared CJK-aware character counting for approximate token estimates.
 *
 * Most LLM tokenizers encode CJK characters as roughly one token per
 * character, while Latin text averages about one token per four characters.
 * The helpers here inflate CJK characters before callers apply the shared
 * chars-per-token heuristic.
 */

export const CHARS_PER_TOKEN_ESTIMATE = 4;

const NON_LATIN_RE =
  /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF9F\uFFE0-\uFFE6\u{20000}-\u{2FA1F}\u{30000}-\u{3347F}]/gu;

const CJK_SURROGATE_RE =
  /(?:[\uD840-\uD87E][\uDC00-\uDFFF]|[\uD880-\uD88C][\uDC00-\uDFFF]|\uD88D[\uDC00-\uDC7F])/g;

export function estimateStringChars(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  const cjkSurrogates = nonLatinCount === 0 ? 0 : (text.match(CJK_SURROGATE_RE) ?? []).length;
  const codePointLength = text.length - cjkSurrogates;
  return codePointLength + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_ESTIMATE);
}
