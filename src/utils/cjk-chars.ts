/**
 * CJK-aware character counting for accurate token estimation.
 *
 * Most LLM tokenizers encode CJK (Chinese, Japanese, Korean) characters as
 * roughly 1 token per character, whereas Latin/ASCII text averages ~1 token
 * per 4 characters.  When the codebase estimates tokens as `chars / 4`, CJK
 * content is underestimated by 2–4×.
 *
 * This module provides a shared helper that inflates the character count of
 * CJK text so that the standard `chars / 4` formula yields an accurate
 * token estimate for any script.
 */

/**
 * Default characters-per-token ratio used throughout the codebase.
 * Latin text ≈ 4 chars/token; CJK ≈ 1 char/token.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Matches CJK Unified Ideographs, CJK Extension A/B, CJK Compatibility
 * Ideographs, Hangul Syllables, Hiragana, Katakana, and other non-Latin
 * scripts and East Asian fullwidth forms that typically use ~1 token per character.
 */
const NON_LATIN_RE =
  /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2FA1F}]/gu;

/**
 * Return an adjusted character length that accounts for non-Latin (CJK, etc.)
 * characters.  Each non-Latin character is counted as
 * {@link CHARS_PER_TOKEN_ESTIMATE} chars so that the downstream
 * `chars / CHARS_PER_TOKEN_ESTIMATE` token estimate remains accurate.
 *
 * For pure ASCII/Latin text the return value equals `text.length` (no change).
 */
export function estimateStringChars(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  // Use code-point length instead of UTF-16 length so that surrogate pairs
  // (CJK Extension B+, U+20000–U+2FA1F) are counted as 1 character, not 2.
  const codePointLength = countCodePoints(text, nonLatinCount);
  // Non-Latin chars already contribute 1 to codePointLength, so add the extra weight.
  return codePointLength + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}

/**
 * Matches surrogate pairs whose code point falls in the CJK Extension B+
 * range (U+20000–U+2FA1F).  Only these surrogates need adjustment because
 * they are matched by {@link NON_LATIN_RE} and already counted in
 * `nonLatinCount`.  Other surrogates (emoji, symbols) are not matched by
 * that regex, so collapsing them would create an inconsistency.
 *
 * High-surrogate range for U+20000–U+2FA1F is D840–D87E.
 */
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;

/**
 * Return the code-point-aware length of the string, adjusting only for
 * CJK Extension B+ surrogate pairs.  For text without such characters
 * (the vast majority of inputs) this returns `text.length` unchanged.
 */
function countCodePoints(text: string, nonLatinCount: number): number {
  if (nonLatinCount === 0) {
    return text.length;
  }
  // Count only CJK-range surrogate pairs — each occupies 2 UTF-16 units
  // but represents 1 code point (and 1 regex match in NON_LATIN_RE).
  const cjkSurrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  return text.length - cjkSurrogates;
}

/**
 * Estimate the number of tokens from a raw character count.
 *
 * For a more accurate estimate when the source text is available, prefer
 * `estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE` instead.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_ESTIMATE);
}
