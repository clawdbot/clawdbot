/**
 * RTL (Right-to-Left) text direction detection.
 * Detects Hebrew, Arabic, Syriac, Thaana, Nko, Samaritan, Mandaic, Adlam,
 * Phoenician, and Lydian scripts using Unicode Script Properties.
 */

const RTL_CHAR_REGEX =
  /\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Samaritan}|\p{Script=Mandaic}|\p{Script=Adlam}|\p{Script=Phoenician}|\p{Script=Lydian}/u;

/**
 * Explicit bidi controls, written as escapes because they are invisible in
 * source. An author who opens with one is asking for that direction, so it
 * outranks the first-strong-character scan the way explicit formatting outranks
 * the implicit level in UAX #9. ALM/RLM/RLE/RLO/RLI ask for rtl; LRM/LRE/LRO/LRI
 * for ltr. Checked before the skip below, which would otherwise swallow them.
 */
const RTL_CONTROL_REGEX = /[\u061C\u200F\u202B\u202E\u2067]/u;
const LTR_CONTROL_REGEX = /[\u200E\u202A\u202D\u2066]/u;

/**
 * Skipped while looking for the first strong character: whitespace, punctuation
 * and symbols (Markdown prefixes such as `**` or `# `), plus the remaining
 * direction-neutral format characters — PDF, PDI, FSI, ZWJ, BOM. Drop the
 * `\p{Cf}` half and those invisible characters reach the script test, match no
 * RTL script, and force `ltr` onto an entire Hebrew or Arabic message.
 */
const NEUTRAL_PREFIX_REGEX = /[\s\p{P}\p{S}\p{Cf}]/u;

/** Detect text direction from the first significant character. */
export function detectTextDirection(text: string | null): "rtl" | "ltr" {
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
    if (NEUTRAL_PREFIX_REGEX.test(char)) {
      continue;
    }
    return RTL_CHAR_REGEX.test(char) ? "rtl" : "ltr";
  }
  return "ltr";
}
