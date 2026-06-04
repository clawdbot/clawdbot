/**
 * Tests text and Markdown chunking helpers exported by the plugin SDK.
 */
import { describe, expect, it } from "vitest";
import { chunkTextForOutbound } from "./text-chunking.js";

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
