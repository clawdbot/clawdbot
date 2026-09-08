// Text chunking tests cover splitting text into bounded model-safe chunks.
import { describe, expect, it } from "vitest";
import { chunkTextByBreakResolver, splitLongTextLine } from "./text-chunking.js";

describe("shared/text-chunking", () => {
  it("returns empty for blank input and the full text when under limit", () => {
    expect(chunkTextByBreakResolver("", 10, () => 5)).toStrictEqual([]);
    expect(chunkTextByBreakResolver("hello", 10, () => 2)).toEqual(["hello"]);
    expect(chunkTextByBreakResolver("hello", 0, () => 2)).toEqual(["hello"]);
    expect(chunkTextByBreakResolver("hello ", 10, () => 2)).toEqual(["hello "]);
    expect(chunkTextByBreakResolver("hello ", 0, () => 2)).toEqual(["hello "]);
  });

  it("splits at resolver-provided breakpoints and trims separator boundaries", () => {
    expect(
      chunkTextByBreakResolver("alpha beta gamma", 10, (window) => window.lastIndexOf(" ")),
    ).toEqual(["alpha", "beta gamma"]);
    expect(chunkTextByBreakResolver("abcd efgh", 4, () => 4)).toEqual(["abcd", "efgh"]);
  });

  it("falls back to hard limits for invalid break indexes", () => {
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => Number.NaN)).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => 99)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => 0)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkTextByBreakResolver("abcdefghij", 4, () => 0.5)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("normalizes positive fractional limits before splitting", () => {
    expect(chunkTextByBreakResolver("abc", 0.5, (window) => window.lastIndexOf(" "))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(splitLongTextLine("abc", 0.5, { preserveWhitespace: true })).toEqual(["a", "b", "c"]);
    expect(chunkTextByBreakResolver("😀😀", 0.5, () => -1)).toEqual(["😀", "😀"]);
    expect(splitLongTextLine("😀😀", 0.5, { preserveWhitespace: true })).toEqual(["😀", "😀"]);
    expect(splitLongTextLine("😀😀", 0.5, { preserveWhitespace: false })).toEqual(["😀", "😀"]);
  });

  it("skips empty chunks created by whitespace-only segments", () => {
    expect(
      chunkTextByBreakResolver("word     next", 5, (window) => window.lastIndexOf(" ")),
    ).toEqual(["word", "next"]);
  });

  it("trims trailing whitespace from emitted chunks before continuing", () => {
    expect(chunkTextByBreakResolver("abc   def", 6, (window) => window.lastIndexOf(" "))).toEqual([
      "abc",
      "def",
    ]);
  });

  it.each([
    { text: "  ! ", limit: 2, expected: ["!"] },
    { text: "a b ", limit: 2, expected: ["a", "b"] },
    { text: "alpha beta   ", limit: 8, expected: ["alpha", "beta"] },
  ])("trims trailing whitespace from the final chunk: $text", ({ text, limit, expected }) => {
    expect(chunkTextByBreakResolver(text, limit, (window) => window.lastIndexOf(" "))).toEqual(
      expected,
    );
  });
});
