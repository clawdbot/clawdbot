/**
 * Tests text and Markdown chunking helpers exported by the plugin SDK.
 */
import { describe, expect, it } from "vitest";
import { chunkTextForOutbound, chunkTextRanges, tokenizeHtmlTags } from "./text-chunking.js";

describe("tokenizeHtmlTags", () => {
  it("keeps quoted attribute delimiters inside one tag token", () => {
    expect([...tokenizeHtmlTags('<a href="https://example.com/?q=>">label</a>')]).toEqual([
      expect.objectContaining({
        raw: '<a href="https://example.com/?q=>">',
        name: "a",
        closing: false,
      }),
      expect.objectContaining({ raw: "</a>", name: "a", closing: true }),
    ]);
  });
});

describe("chunkTextForOutbound", () => {
  it.each([
    {
      name: "returns empty for empty input",
      text: "",
      maxLen: 10,
      expected: [],
    },
    {
      name: "splits on newline or whitespace boundaries",
      text: "alpha\nbeta gamma",
      maxLen: 8,
      expected: ["alpha", "beta", "gamma"],
    },
    {
      name: "falls back to hard limit when no separator exists",
      text: "abcdefghij",
      maxLen: 4,
      expected: ["abcd", "efgh", "ij"],
    },
  ])("$name", ({ text, maxLen, expected }) => {
    expect(chunkTextForOutbound(text, maxLen)).toEqual(expected);
  });
});

describe("chunkTextRanges", () => {
  it("returns contiguous hard ranges without dropping whitespace", () => {
    const text = "alpha  beta\n\ngamma delta";
    const ranges = chunkTextRanges(text, { limit: 12, mode: "hard" });

    expect(ranges).toEqual([
      { start: 0, end: 12 },
      { start: 12, end: 24 },
    ]);
    expect(ranges.map(({ start, end }) => text.slice(start, end))).toEqual([
      "alpha  beta\n",
      "\ngamma delta",
    ]);
  });

  it("prefers paragraph, newline, then whitespace boundaries", () => {
    const text = "a\n\nb\nc xyz";
    const ranges = chunkTextRanges(text, { limit: 8, mode: "preferred" });

    expect(ranges.map(({ start, end }) => text.slice(start, end))).toEqual(["a\n\n", "b\nc xyz"]);
  });

  it("falls back to hard ranges and handles empty or non-positive limits", () => {
    expect(chunkTextRanges("abcdefgh", { limit: 3, mode: "preferred" })).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 8 },
    ]);
    expect(chunkTextRanges("", { limit: 3 })).toEqual([]);
    expect(chunkTextRanges("abc", { limit: 0 })).toEqual([{ start: 0, end: 3 }]);
  });

  it.each(["hard", "preferred"] as const)("keeps surrogate pairs intact in %s mode", (mode) => {
    expect(chunkTextRanges("a😀b", { limit: 2, mode })).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 3 },
      { start: 3, end: 4 },
    ]);
  });
});
