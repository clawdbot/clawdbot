import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateTokensFromChars,
} from "./cjk-chars.js";

describe("normalization-core/cjk-chars", () => {
  it("keeps Latin text on the regular chars-per-token heuristic", () => {
    expect(estimateStringChars("hello world")).toBe(11);
    expect(estimateTokensFromChars(9)).toBe(3);
  });

  it("weights common CJK text as roughly one token per character", () => {
    expect(estimateStringChars("\u4F60\u597D\u4E16\u754C")).toBe(4 * CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars("hi\u4F60\u597D")).toBe(10);
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
