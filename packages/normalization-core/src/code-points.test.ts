import { describe, expect, it } from "vitest";
import { countCodePoints, truncateCodePoints } from "./code-points.js";

const samples = [
  ["empty", ""],
  ["ASCII", "ordinary text ".repeat(128)],
  ["CJK", "中文かな한글".repeat(128)],
  ["astral", "a🦞b🙂".repeat(128)],
  ["combining marks", "é".repeat(128)],
  ["ZWJ families", "👨‍👩‍👧‍👦".repeat(64)],
  ["flags", "🇹🇼🇯🇵".repeat(64)],
  ["lone surrogates", "\ud83da\ude00b😀\ud83d"],
] as const;

describe("code-point measurement", () => {
  it.each(samples)("matches the string iterator for %s", (_name, text) => {
    const points = Array.from(text);
    expect(countCodePoints(text)).toBe(points.length);
    for (const limit of [0, 1, 20, 40, 64, 80, 256, 400, 800]) {
      expect(truncateCodePoints(text, limit)).toBe(points.slice(0, limit).join(""));
    }
  });

  it("counts code points independently of grapheme clusters", () => {
    expect(truncateCodePoints("👨‍👩‍👧‍👦", 2)).toBe("👨‍");
    expect(countCodePoints("👨‍👩‍👧‍👦")).toBe(7);
  });
});
