/**
 * Shared CJK-aware character counting for approximate token estimates.
 *
 * This is a provider-independent budget heuristic, not an exact tokenizer.
 * Weighting common CJK, rare BMP characters, width-compatibility forms, and
 * supplementary ideographs separately keeps current tokenizers within a
 * conservative budget range while preserving the existing Latin behavior.
 */

export const CHARS_PER_TOKEN_ESTIMATE = 4;

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

/**
 * What one UTF-16 unit of a surcharged class costs: the class's total charge for a match,
 * divided by the units that match spans, so supplementary pairs are priced per unit.
 * `text.length` already charges every unit 1, leaving `unitsPerMatch * (unitWeight - 1)` as
 * the surcharge. estimateStringChars() adds that up; rawCharsWithinEstimate() reads the
 * same numbers backwards, so one table keeps the two directions from drifting apart.
 */
type EstimateUnitWeight = { pattern: RegExp; unitsPerMatch: number; unitWeight: number };

/** Heaviest first — rawCharsWithinEstimate() funds the densest characters first. */
const SPECIAL_CJK_WEIGHTS: readonly EstimateUnitWeight[] = [
  { pattern: RARE_BMP_CJK_RE, unitsPerMatch: 1, unitWeight: CHARS_PER_TOKEN_ESTIMATE * 3 },
  { pattern: TWO_TOKEN_CJK_RE, unitsPerMatch: 1, unitWeight: CHARS_PER_TOKEN_ESTIMATE * 2 },
  { pattern: SUPPLEMENTARY_CJK_RE, unitsPerMatch: 2, unitWeight: CHARS_PER_TOKEN_ESTIMATE * 2 },
  {
    pattern: THREE_TOKEN_SUPPLEMENTARY_CJK_RE,
    unitsPerMatch: 2,
    unitWeight: (CHARS_PER_TOKEN_ESTIMATE * 3) / 2,
  },
];
const COMMON_CJK_WEIGHTS: readonly EstimateUnitWeight[] = [
  { pattern: COMMON_CJK_RE, unitsPerMatch: 1, unitWeight: CHARS_PER_TOKEN_ESTIMATE },
];
/** Still heaviest first: common CJK is the lightest surcharged class. */
const ESTIMATE_UNIT_WEIGHTS: readonly EstimateUnitWeight[] = [
  ...SPECIAL_CJK_WEIGHTS,
  ...COMMON_CJK_WEIGHTS,
];

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function surchargeAbovePlainChars(text: string, weights: readonly EstimateUnitWeight[]): number {
  return weights.reduce(
    (total, { pattern, unitsPerMatch, unitWeight }) =>
      total + countMatches(text, pattern) * unitsPerMatch * (unitWeight - 1),
    0,
  );
}

export function estimateStringChars(text: string): number {
  if (!NON_ASCII_RE.test(text)) {
    return text.length;
  }
  // The special classes stay behind their own probe so accented Latin costs one extra
  // scan rather than four.
  const commonEstimate = text.length + surchargeAbovePlainChars(text, COMMON_CJK_WEIGHTS);
  return SPECIAL_CJK_RE.test(text)
    ? commonEstimate + surchargeAbovePlainChars(text, SPECIAL_CJK_WEIGHTS)
    : commonEstimate;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * How many raw UTF-16 units `estimatedChars` buys for text made of the character classes
 * `text` contains: every character of `text` is funded at its own weight, heaviest class
 * first, and whatever budget is left over is quoted at the ASCII weight of 1.
 *
 * Callers hold a budget in the estimated chars this module charges but spend it by slicing
 * raw offsets, and one character costs anywhere from 1 to CHARS_PER_TOKEN_ESTIMATE * 3 of
 * them, so neither the raw length nor a flat CHARS_PER_TOKEN_ESTIMATE conversion is right
 * for both scripts. Funding the heaviest characters first makes the result a safe cap
 * whichever part of `text` a caller keeps: the return can only exceed `text.length` once
 * the whole of `text` is already within budget. Quoting the remainder rather than clipping
 * it to `text.length` also keeps the number usable as a budget told to a producer, instead
 * of shrinking to whatever the current draft happens to be. ASCII converts 1:1 either way,
 * so Latin budgets are unchanged.
 */
export function rawCharsWithinEstimate(text: string, estimatedChars: number): number {
  let remaining = Math.max(0, estimatedChars);
  let rawChars = 0;
  for (const { pattern, unitsPerMatch, unitWeight } of ESTIMATE_UNIT_WEIGHTS) {
    const units = countMatches(text, pattern) * unitsPerMatch;
    const affordable = Math.min(units, Math.floor(remaining / unitWeight));
    rawChars += affordable;
    remaining -= affordable * unitWeight;
  }
  return rawChars + remaining;
}
