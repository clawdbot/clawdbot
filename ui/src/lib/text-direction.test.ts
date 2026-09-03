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
];

describe("detectTextDirection", () => {
  it.each(CASES)("resolves %s", (_name, text, expected) => {
    expect(detectTextDirection(text)).toBe(expected);
  });
});
