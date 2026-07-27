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
    expect(estimateStringChars("\u4F60\u597D\u4E16\u754C")).toBe(
      4 * CHARS_PER_TOKEN_ESTIMATE,
    );
    expect(estimateStringChars("hi\u4F60\u597D")).toBe(10);
  });

  it("counts CJK extension surrogate pairs as one weighted code point", () => {
    expect(estimateStringChars(String.fromCodePoint(0x20000))).toBe(CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars(String.fromCodePoint(0x30000))).toBe(CHARS_PER_TOKEN_ESTIMATE);
  });

  it("does not collapse non-CJK surrogate pairs", () => {
    expect(estimateStringChars("\uD83D\uDE00")).toBe(2);
  });
});
