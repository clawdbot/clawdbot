/**
 * CJK-aware character weighting for Ollama usage fallback estimates.
 *
 * This stays plugin-private because exposing it through the Plugin SDK would
 * create a stable public contract for one provider-specific fallback. Keep
 * the weighting aligned with normalization-core's CJK budget heuristic.
 */

const CHARS_PER_TOKEN_ESTIMATE = 4;

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
  return (text.match(pattern) ?? []).length;
}

export function estimateStringChars(text: string): number {
  if (!NON_ASCII_RE.test(text)) {
    return text.length;
  }
  const commonCjkCount = countMatches(text, COMMON_CJK_RE);
  const commonEstimate = text.length + commonCjkCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
  if (!SPECIAL_CJK_RE.test(text)) {
    return commonEstimate;
  }
  const rareBmpCjkCount = countMatches(text, RARE_BMP_CJK_RE);
  const twoTokenCjkCount = countMatches(text, TWO_TOKEN_CJK_RE);
  const threeTokenSupplementaryCjkCount = countMatches(text, THREE_TOKEN_SUPPLEMENTARY_CJK_RE);
  const supplementaryCjkCount = countMatches(text, SUPPLEMENTARY_CJK_RE);
  return (
    commonEstimate +
    rareBmpCjkCount * (CHARS_PER_TOKEN_ESTIMATE * 3 - 1) +
    twoTokenCjkCount * (CHARS_PER_TOKEN_ESTIMATE * 2 - 1) +
    threeTokenSupplementaryCjkCount * (CHARS_PER_TOKEN_ESTIMATE * 3 - 2) +
    supplementaryCjkCount * (CHARS_PER_TOKEN_ESTIMATE * 4 - 2)
  );
}
