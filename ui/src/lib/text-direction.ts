/**
 * RTL (Right-to-Left) text direction detection.
 * Detects Hebrew, Arabic, Syriac, Thaana, Nko, Samaritan, Mandaic, Adlam,
 * Phoenician, and Lydian scripts using Unicode Script Properties.
 */

const RTL_CHAR_REGEX =
  /\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Samaritan}|\p{Script=Mandaic}|\p{Script=Adlam}|\p{Script=Phoenician}|\p{Script=Lydian}/u;

/**
 * Detect text direction from the first significant character.
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
    if (skipPattern.test(char)) {
      continue;
    }
    return RTL_CHAR_REGEX.test(char) ? "rtl" : "ltr";
  }
  return "ltr";
}
