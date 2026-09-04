import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateTokensFromChars,
  rawCharsWithinEstimate,
} from "./cjk-chars.js";

/** U+4E2D, in the common-CJK range, so it weighs CHARS_PER_TOKEN_ESTIMATE per character. */
const COMMON_CJK = "中";

describe("normalization-core/cjk-chars", () => {
  it("keeps Latin text on the regular chars-per-token heuristic", () => {
    expect(estimateStringChars("")).toBe(0);
    expect(estimateStringChars("hello world")).toBe(11);
    expect(estimateStringChars("123.45, hello! @#$%")).toBe(19);
  });

  it("weights common CJK text as roughly one token per character", () => {
    expect(estimateStringChars("\u4F60\u597D\u4E16\u754C")).toBe(4 * CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars("hi\u4F60\u597D")).toBe(10);
  });

  it.each([
    ["hiragana", "こんにちは", 20],
    ["katakana", "カタカナ", 16],
    ["Hangul", "안녕하세요", 20],
    ["fullwidth letters and numbers", "ＡＢＣ１２３", 24],
    ["fullwidth punctuation with Latin text", "hello，world", 14],
    ["mixed BMP and supplementary CJK", "你𠀀好", 24],
    ["mixed CJK and emoji", "你😀", 6],
  ])("weights %s", (_label, text, expected) => {
    expect(estimateStringChars(text)).toBe(expected);
  });

  it.each([
    [8, 2],
    [9, 3],
    [0, 0],
    [-10, 0],
  ])("estimates %s weighted characters as %s tokens", (chars, expected) => {
    expect(estimateTokensFromChars(chars)).toBe(expected);
  });

  it("uses measured weights for halfwidth and supplementary CJK", () => {
    expect(estimateStringChars("ｺﾝﾆﾁﾊ")).toBe(5 * CHARS_PER_TOKEN_ESTIMATE * 2);
    expect(estimateStringChars(String.fromCodePoint(0xffa1))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
    expect(estimateStringChars(String.fromCodePoint(0x20000))).toBe(CHARS_PER_TOKEN_ESTIMATE * 4);
    expect(estimateStringChars(String.fromCodePoint(0x30000))).toBe(CHARS_PER_TOKEN_ESTIMATE * 4);
  });

  it("weights decomposed Hangul and compatibility forms", () => {
    const decomposedHangul = "안녕하세요".normalize("NFD");
    expect(estimateStringChars(decomposedHangul)).toBe(
      decomposedHangul.length * CHARS_PER_TOKEN_ESTIMATE * 3,
    );
    expect(estimateStringChars(String.fromCodePoint(0xa960))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
    expect(estimateStringChars(String.fromCodePoint(0xd7b0))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
    expect(estimateStringChars(String.fromCodePoint(0xfe10))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
    expect(estimateStringChars(String.fromCodePoint(0xffe0))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
  });

  it.each([0x2e80, 0x3400, 0x9fff, 0xa000, 0xf900])(
    "uses a conservative rare-BMP weight for U+%s",
    (codePoint) => {
      expect(estimateStringChars(String.fromCodePoint(codePoint))).toBe(
        CHARS_PER_TOKEN_ESTIMATE * 3,
      );
    },
  );

  it.each([0x16fe3, 0x1aff0, 0x1b001, 0x1b11f, 0x1b132, 0x1f200])(
    "uses a conservative supplementary-CJK weight for U+%s",
    (codePoint) => {
      expect(estimateStringChars(String.fromCodePoint(codePoint))).toBe(
        CHARS_PER_TOKEN_ESTIMATE * 4,
      );
    },
  );

  it("covers CJK script-extension marks with measured weights", () => {
    expect(estimateStringChars(String.fromCodePoint(0x00b7))).toBe(CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars("·".repeat(32))).toBe(32 * CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars(String.fromCodePoint(0x02ca))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
    expect(estimateStringChars(String.fromCodePoint(0xa700))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
    expect(estimateStringChars(String.fromCodePoint(0x1d360))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
  });

  it("does not collapse non-CJK surrogate pairs", () => {
    expect(estimateStringChars("\uD83D\uDE00")).toBe(2);
  });
});

describe("normalization-core/cjk-chars rawCharsWithinEstimate", () => {
  it("converts Latin budgets one to one, so callers slicing raw offsets are unchanged", () => {
    expect(rawCharsWithinEstimate("a".repeat(100), 40)).toBe(40);
    expect(rawCharsWithinEstimate("a".repeat(100), 0)).toBe(0);
    // Budget beyond the text is quoted, not clipped to the current draft: callers tell a
    // producer how much room it has, and a short draft must not shrink that number.
    expect(rawCharsWithinEstimate("a".repeat(100), 400)).toBe(400);
    expect(rawCharsWithinEstimate("", 400)).toBe(400);
  });

  it("buys a quarter as many common CJK characters as the raw length would", () => {
    expect(rawCharsWithinEstimate(COMMON_CJK.repeat(100), 40)).toBe(40 / CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars(COMMON_CJK.repeat(10))).toBe(40);
  });

  it("prices supplementary pairs per UTF-16 unit", () => {
    const supplementary = String.fromCodePoint(0x20000).repeat(10);
    const fits = rawCharsWithinEstimate(supplementary, 80);
    expect(fits).toBe(10);
    expect(estimateStringChars(supplementary.slice(0, fits))).toBeLessThanOrEqual(80);
  });

  it("only quotes past the text length once the whole text is within budget", () => {
    // The cap stays safe despite quoting the remainder: it can exceed text.length only
    // when every character of the text was funded at its own weight.
    const text = `${"a".repeat(100)}${COMMON_CJK.repeat(100)}`;
    expect(estimateStringChars(text)).toBe(500);
    expect(rawCharsWithinEstimate(text, 500)).toBeGreaterThanOrEqual(text.length);
    expect(rawCharsWithinEstimate(text, 499)).toBeLessThan(text.length);
  });

  it("funds the heaviest characters present, so every slice of that length fits", () => {
    // The contract is a bound for ANY selection, not the average: a caller that trims to
    // the returned length cannot overrun the budget by keeping the denser half.
    const text = `${"a".repeat(1_000)}${COMMON_CJK.repeat(1_000)}`;
    const budget = 2_000;
    const fits = rawCharsWithinEstimate(text, budget);
    // 500 CJK characters at CHARS_PER_TOKEN_ESTIMATE each exhaust the budget on their own.
    expect(fits).toBe(500);
    for (const slice of [
      text.slice(0, fits),
      text.slice(-fits),
      `${"a".repeat(fits / 2)}${COMMON_CJK.repeat(fits / 2)}`,
    ]) {
      expect(slice).toHaveLength(fits);
      expect(estimateStringChars(slice)).toBeLessThanOrEqual(budget);
    }
  });
});
