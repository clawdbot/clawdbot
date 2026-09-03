/**
 * RTL (Right-to-Left) text direction detection.
 * Detects Hebrew, Arabic, Syriac, Thaana, Nko, Samaritan, Mandaic, Adlam,
 * Phoenician, and Lydian scripts using Unicode Script Properties.
 */

const RTL_CHAR_REGEX =
  /\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Samaritan}|\p{Script=Mandaic}|\p{Script=Adlam}|\p{Script=Phoenician}|\p{Script=Lydian}/u;

/**
 * Explicit right-to-left bidi controls, written as escapes because they are
 * invisible in source: ALM (U+061C), RLM (U+200F), RLE (U+202B), RLO (U+202E),
 * RLI (U+2067). An author who opens with one of these is asking for RTL, so
 * honor it directly instead of scanning further.
 */
const RTL_CONTROL_REGEX = /[\u061C\u200F\u202B\u202E\u2067]/u;

/**
 * Explicit left-to-right bidi controls: LRM (U+200E), LRE (U+202A),
 * LRO (U+202D), LRI (U+2066).
 */
const LTR_CONTROL_REGEX = /[\u200E\u202A\u202D\u2066]/u;

/**
 * Remaining format characters (general category Cf) carry no direction of their
 * own — PDF, PDI, FSI, ZWJ/ZWNJ, BOM and friends. They must be stepped over so
 * they do not mask the first strong character behind them.
 */
const FORMAT_CHAR_REGEX = /\p{Cf}/u;

/**
 * Detect text direction from the first significant character.
 *
 * Explicit bidi controls win, mirroring the "explicit directional formatting"
 * step of the Unicode bidirectional algorithm (UAX #9). Otherwise the first
 * strong character decides, and any remaining format characters are skipped.
 *
 * @param text - The text to check
 * @param skipPattern - Characters to skip when looking for the first significant char.
 *   Defaults to whitespace and Unicode punctuation/symbols.
 */
export function detectTextDirection(
  text: string | null,
  skipPattern = /[\s\p{P}\p{S}]/u,
): "rtl" | "ltr" {
  if (!text) {
    return "ltr";
  }
  for (const char of text) {
    if (RTL_CONTROL_REGEX.test(char)) {
      return "rtl";
    }
    if (LTR_CONTROL_REGEX.test(char)) {
      return "ltr";
    }
    if (FORMAT_CHAR_REGEX.test(char) || skipPattern.test(char)) {
      continue;
    }
    return RTL_CHAR_REGEX.test(char) ? "rtl" : "ltr";
  }
  return "ltr";
}
