/**
 * Shared CJK-aware character counting for approximate token estimates.
 *
 * This is a provider-independent budget heuristic, not an exact tokenizer.
 * Weighting common CJK, rare BMP characters, width-compatibility forms, and
 * supplementary ideographs separately keeps current tokenizers within a
 * conservative budget range while preserving the existing Latin behavior.
 */

export const CHARS_PER_TOKEN_ESTIMATE = 4;

export type StringCharBudgetOptions = { minimumRawWeight?: number };
const DEFAULT_BUDGET_OPTIONS: StringCharBudgetOptions = {};
const ASCII_RUN_OR_NON_ASCII_CODE_POINT_RE = /[\p{ASCII}]+|[^\p{ASCII}]/gu;
const NON_ASCII_RE = /[\u0080-\u{10FFFF}]/u;
const COMMON_CJK_RE = /[\u00B7\u3000-\u319F\u4E00-\u9FA5\uAC00-\uD7AF\uFF01-\uFF60]/gu;
const RARE_BMP_CJK_RE =
  /[\u1100-\u11FF\u2E80-\u2FFF\u31A0-\u4DFF\u9FA6-\u9FFF\uA000-\uA4FF\uA700-\uA707\uA960-\uA97F\uD7B0-\uD7FF\uF900-\uFAFF]/gu;
const TWO_TOKEN_CJK_RE =
  /[\u{02C7}\u{02C9}-\u{02CB}\u{02D9}\u{02EA}-\u{02EB}\uFE10-\uFE4F\uFF61-\uFFDC\uFFE0-\uFFE6]|\u{0305}|\u{0323}/gu;
const THREE_TOKEN_SUPPLEMENTARY_CJK_RE = /[\u{1D360}-\u{1D371}]/gu;
const SUPPLEMENTARY_CJK_RE =
  /[\u{16FE0}-\u{16FFF}\u{1AFF0}-\u{1AFFF}\u{1B000}-\u{1B16F}\u{1F200}-\u{1F2FF}\u{20000}-\u{2FA1F}\u{30000}-\u{3347F}]/gu;
const SPECIAL_CJK_RE =
  /[\u{02C7}\u{02C9}-\u{02CB}\u{02D9}\u{02EA}-\u{02EB}\u1100-\u11FF\u2E80-\u2FFF\u31A0-\u4DFF\u9FA6-\u9FFF\uA000-\uA4FF\uA700-\uA707\uA960-\uA97F\uD7B0-\uD7FF\uF900-\uFAFF\uFE10-\uFE4F\uFF61-\uFFDC\uFFE0-\uFFE6\u{16FE0}-\u{16FFF}\u{1AFF0}-\u{1AFFF}\u{1B000}-\u{1B16F}\u{1D360}-\u{1D371}\u{1F200}-\u{1F2FF}\u{20000}-\u{2FA1F}\u{30000}-\u{3347F}]|\u{0305}|\u{0323}/u;

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  // Every pattern consumes a code point; the final failed test resets its cursor.
  while (pattern.test(text)) {
    count += 1;
  }
  return count;
}

export function estimateStringChars(text: string): number {
  return estimateStringCharsWithMinimumRawWeight(text);
}

/** Apply a raw-text safety floor without multiplying CJK adjustments twice. */
export function estimateStringCharsWithMinimumRawWeight(
  text: string,
  options: StringCharBudgetOptions = DEFAULT_BUDGET_OPTIONS,
): number {
  const minimumRawWeight = Math.max(1, options.minimumRawWeight ?? 1);
  if (minimumRawWeight !== 1 && minimumRawWeight !== 2) {
    let chars = 0;
    // Other floors retain per-ASCII-run rounding and left-to-right numeric behavior.
    for (const match of text.matchAll(ASCII_RUN_OR_NON_ASCII_CODE_POINT_RE)) {
      const segment = match[0];
      const minimumChars = Math.ceil(segment.length * minimumRawWeight);
      chars +=
        segment.charCodeAt(0) <= 0x7f
          ? minimumChars
          : Math.max(estimateStringChars(segment), minimumChars);
    }
    return chars;
  }
  if (!NON_ASCII_RE.test(text)) {
    return text.length * minimumRawWeight;
  }
  const commonEstimate =
    text.length * minimumRawWeight +
    countMatches(text, COMMON_CJK_RE) * (CHARS_PER_TOKEN_ESTIMATE - minimumRawWeight);
  if (!SPECIAL_CJK_RE.test(text)) {
    return commonEstimate;
  }
  return (
    commonEstimate +
    countMatches(text, RARE_BMP_CJK_RE) * (CHARS_PER_TOKEN_ESTIMATE * 3 - minimumRawWeight) +
    countMatches(text, TWO_TOKEN_CJK_RE) * (CHARS_PER_TOKEN_ESTIMATE * 2 - minimumRawWeight) +
    countMatches(text, THREE_TOKEN_SUPPLEMENTARY_CJK_RE) *
      (CHARS_PER_TOKEN_ESTIMATE * 3 - 2 * minimumRawWeight) +
    countMatches(text, SUPPLEMENTARY_CJK_RE) * (CHARS_PER_TOKEN_ESTIMATE * 4 - 2 * minimumRawWeight)
  );
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_ESTIMATE);
}
