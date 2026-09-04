// @vitest-environment node
// Control UI tests cover text direction behavior.
import { describe, expect, it } from "vitest";
import { detectTextDirection } from "./text-direction.ts";

// Bidi controls are invisible, so every case names the character it exercises.
const CASES: [name: string, text: string | null, expected: "rtl" | "ltr"][] = [
  ["null", null, "ltr"],
  ["empty string", "", "ltr"],
  ["hebrew", "\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD", "rtl"],
  ["arabic", "\u0645\u0631\u062D\u0628\u0627", "rtl"],
  ["latin", "Hello world", "ltr"],
  ["markdown emphasis before hebrew", "**\u05E9\u05DC\u05D5\u05DD", "rtl"],
  ["markdown heading before arabic", "# \u0645\u0631\u062D\u0628\u0627", "rtl"],
  ["markdown list before latin", "- hello", "ltr"],
  ["RLM before hebrew", "\u200F\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD", "rtl"],
  ["RLE before hebrew", "\u202B\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD", "rtl"],
  ["RLI before hebrew", "\u2067\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD", "rtl"],
  ["ALM before arabic", "\u061C\u0645\u0631\u062D\u0628\u0627", "rtl"],
  ["RLM overriding latin", "\u200FHello", "rtl"],
  ["RLO overriding latin", "\u202EHello", "rtl"],
  ["LRM overriding hebrew", "\u200E\u05E9\u05DC\u05D5\u05DD", "ltr"],
  ["LRE overriding hebrew", "\u202A\u05E9\u05DC\u05D5\u05DD", "ltr"],
  ["LRO overriding hebrew", "\u202D\u05E9\u05DC\u05D5\u05DD", "ltr"],
  ["LRI overriding hebrew", "\u2066\u05E9\u05DC\u05D5\u05DD", "ltr"],
  ["RLI and PDI around hebrew", "\u2067\u05E9\u05DC\u05D5\u05DD\u2069", "rtl"],
  ["FSI and PDI around hebrew", "\u2068\u05E9\u05DC\u05D5\u05DD\u2069", "rtl"],
  ["PDF before hebrew", "\u202C\u05E9\u05DC\u05D5\u05DD", "rtl"],
  ["ZWJ before hebrew", "\u200D\u05E9\u05DC\u05D5\u05DD", "rtl"],
  ["BOM before hebrew", "\uFEFF\u05E9\u05DC\u05D5\u05DD", "rtl"],
  ["BOM before latin", "\uFEFFHello", "ltr"],
  ["format characters only", "\uFEFF\u200D", "ltr"],
  // U+0600-U+0604, U+070F, U+0890 and U+0891 are both Cf and an RTL script, so the skip class
  // steps over them and the strong letter behind them decides. Pinned per code point because a
  // narrower skip class would resolve them on sight and mask the letter.
  ["ARABIC NUMBER SIGN before arabic", "\u0600\u0628", "rtl"],
  ["ARABIC SIGN SANAH before arabic", "\u0601\u0628", "rtl"],
  ["ARABIC FOOTNOTE MARKER before arabic", "\u0602\u0628", "rtl"],
  ["ARABIC SIGN SAFHA before arabic", "\u0603\u0628", "rtl"],
  ["ARABIC SIGN SAMVAT before arabic", "\u0604\u0628", "rtl"],
  ["SYRIAC ABBREVIATION MARK before arabic", "\u070F\u0628", "rtl"],
  ["ARABIC POUND MARK ABOVE before arabic", "\u0890\u0628", "rtl"],
  ["ARABIC PIASTRE MARK ABOVE before arabic", "\u0891\u0628", "rtl"],
  ["ARABIC NUMBER SIGN before arabic-indic digit", "\u0600\u0663", "rtl"],
  // No strong character anywhere: an Arabic number sign and an ASCII digit are both weak types,
  // so first-strong finds nothing and the ltr default stands. Pinned so a future skip-class
  // change has to be deliberate about it.
  ["ARABIC NUMBER SIGN before ascii digit", "\u06003", "ltr"],
];

describe("detectTextDirection", () => {
  it.each(CASES)("resolves %s", (_name, text, expected) => {
    expect(detectTextDirection(text)).toBe(expected);
  });

  // Enumerated cases can only pin the characters someone thought of. This sweeps the whole
  // Cf family so a skip class that silently stops covering part of it fails here.
  it("steps over every direction-neutral format character to reach the strong letter", () => {
    const HEBREW_LETTER = "\u05E9";
    const EXPLICIT_LTR = new Set(["\u200E", "\u202A", "\u202D", "\u2066"]);
    const offenders: string[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        continue;
      }
      const char = String.fromCodePoint(codePoint);
      if (!/\p{Cf}/u.test(char)) {
        continue;
      }
      // A leading left-to-right override is meant to win; everything else must fall through.
      const expected = EXPLICIT_LTR.has(char) ? "ltr" : "rtl";
      const actual = detectTextDirection(char + HEBREW_LETTER);
      if (actual !== expected) {
        offenders.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} -> ${actual}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
