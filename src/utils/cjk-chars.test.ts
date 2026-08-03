// CJK character tests cover detection and width handling for CJK text.
import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateTokensFromChars,
} from "./cjk-chars.js";

describe("estimateStringChars", () => {
  it("returns plain string length for ASCII text", () => {
    expect(estimateStringChars("hello world")).toBe(11);
  });

  it("returns 0 for empty string", () => {
    expect(estimateStringChars("")).toBe(0);
  });

  it("counts Chinese characters with extra weight", () => {
    // "你好世" = 3 CJK chars
    // Each CJK char counted as CHARS_PER_TOKEN_ESTIMATE (4) chars
    // .length = 3, adjusted = 3 + 3 * (4 - 1) = 12
    expect(estimateStringChars("你好世")).toBe(12);
  });

  it("handles mixed ASCII and CJK text", () => {
    // "hi你好" = 2 ASCII + 2 CJK
    // .length = 4, adjusted = 4 + 2 * 3 = 10
    expect(estimateStringChars("hi你好")).toBe(10);
  });

  it("handles Japanese hiragana", () => {
    // "こんにちは" = 5 hiragana chars
    // .length = 5, adjusted = 5 + 5 * 3 = 20
    expect(estimateStringChars("こんにちは")).toBe(20);
  });

  it("handles Japanese katakana", () => {
    // "カタカナ" = 4 katakana chars
    // .length = 4, adjusted = 4 + 4 * 3 = 16
    expect(estimateStringChars("カタカナ")).toBe(16);
  });

  it("handles Korean hangul", () => {
    // "안녕하세요" = 5 hangul chars
    // .length = 5, adjusted = 5 + 5 * 3 = 20
    expect(estimateStringChars("안녕하세요")).toBe(20);
  });

  it("handles East Asian fullwidth letters, numbers, and punctuation", () => {
    expect(estimateStringChars("ＡＢＣ１２３")).toBe(6 * CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars("hello，world")).toBe(
      "helloworld".length + CHARS_PER_TOKEN_ESTIMATE,
    );
  });

  it("handles CJK punctuation and symbols in the extended range", () => {
    // "⺀" (U+2E80) is a rare radical that current tokenizers encode as 3 tokens.
    expect(estimateStringChars("⺀")).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
  });

  it("does not inflate standard Latin characters", () => {
    const latin = "The quick brown fox jumps over the lazy dog";
    expect(estimateStringChars(latin)).toBe(latin.length);
  });

  it("does not inflate numbers and basic punctuation", () => {
    const text = "123.45, hello! @#$%";
    expect(estimateStringChars(text)).toBe(text.length);
  });

  it("weights CJK Extension B characters for their measured token cost", () => {
    // "𠀀" (U+20000) is represented as a surrogate pair in UTF-16.
    expect(estimateStringChars("𠀀")).toBe(CHARS_PER_TOKEN_ESTIMATE * 4);
  });

  it("handles mixed BMP and Extension B CJK weights", () => {
    expect(estimateStringChars("你𠀀好")).toBe(CHARS_PER_TOKEN_ESTIMATE * 6);
  });

  it("weights halfwidth Japanese, halfwidth Hangul, and supplementary CJK", () => {
    expect(estimateStringChars("ｺﾝﾆﾁﾊ")).toBe(CHARS_PER_TOKEN_ESTIMATE * 10);
    expect(estimateStringChars(String.fromCodePoint(0xffa1))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
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
    "weights rare BMP CJK U+%s conservatively",
    (codePoint) => {
      expect(estimateStringChars(String.fromCodePoint(codePoint))).toBe(
        CHARS_PER_TOKEN_ESTIMATE * 3,
      );
    },
  );

  it.each([0x16fe3, 0x1aff0, 0x1b001, 0x1b11f, 0x1b132, 0x1f200])(
    "weights supplementary CJK U+%s conservatively",
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

  it("does not collapse non-CJK surrogate pairs like emoji", () => {
    // Emoji is a surrogate pair in UTF-16, but not matched by NON_LATIN_RE.
    // Its weighted length should remain the UTF-16 length (2).
    expect(estimateStringChars("😀")).toBe(2);
  });

  it("keeps mixed CJK and emoji weighting consistent", () => {
    // "你" counts as 4, emoji remains 2 => total 6
    expect(estimateStringChars("你😀")).toBe(6);
  });
  it("yields ~1 token per CJK char when divided by CHARS_PER_TOKEN_ESTIMATE", () => {
    // 10 CJK chars should estimate as ~10 tokens
    const cjk = "这是一个测试用的句子呢";
    const estimated = estimateStringChars(cjk);
    const tokens = Math.ceil(estimated / CHARS_PER_TOKEN_ESTIMATE);
    // Each CJK char ≈ 1 token, so tokens should be close to string length
    expect(tokens).toBe(cjk.length);
  });
});

describe("estimateTokensFromChars", () => {
  it("divides by CHARS_PER_TOKEN_ESTIMATE and rounds up", () => {
    expect(estimateTokensFromChars(8)).toBe(2);
    expect(estimateTokensFromChars(9)).toBe(3);
    expect(estimateTokensFromChars(0)).toBe(0);
  });

  it("clamps negative values to 0", () => {
    expect(estimateTokensFromChars(-10)).toBe(0);
  });
});
