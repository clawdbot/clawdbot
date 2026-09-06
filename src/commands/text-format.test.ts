// Text format tests cover command-facing shortening helpers.
import { describe, expect, it } from "vitest";
import { formatTextCell, shortenText } from "./text-format.js";

describe("shortenText", () => {
  it.each([
    ["", 1, ""],
    ["openclaw", 16, "openclaw"],
    ["openclaw-status-output", 10, "openclaw-…"],
    ["openclaw", 0, ""],
    ["openclaw", -1, ""],
    ["hello🙂world", 7, "hello🙂…"],
    ["🙂🙂🙂", 3, "🙂🙂🙂"],
    ["🙂🙂🙂🙂", 3, "🙂🙂…"],
    ["a🙂🙂🙂🙂", 3, "a🙂…"],
    ["🙂x", 1, "…"],
    ["e\u0301x", 2, "e…"],
  ])("shortens %j to %i code points", (input, maxLen, expected) => {
    expect(shortenText(input, maxLen)).toBe(expected);
  });
});

describe("formatTextCell raw output bound", () => {
  it.each([
    ["abc", 5, "abc  "],
    ["表", 4, "表  "],
    ["e\u0301", 3, "e\u0301  "],
    ["\u001b[31mred\u001b[0m", 4, "\u001b[31mred\u001b[0m "],
  ])("pads fitting %j to %s visible columns", (input, width, expected) => {
    expect(formatTextCell(input, width)).toBe(expected);
  });

  it.each([
    ["zero-width overflow", "\u200b".repeat(32), "\u200b".repeat(14) + "… "],
    ["exact zero-width raw boundary", "\u200b".repeat(14), "\u200b".repeat(14) + "  "],
    ["one oversized combining cluster", "e" + "\u0301".repeat(16), "… "],
    ["one oversized ZWJ cluster", "👩" + "\u200d👩".repeat(8), "… "],
    ["prefix before an oversized cluster", "Ae" + "\u0301".repeat(16), "A…"],
    ["ordinary family emoji", "👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦"],
  ])("preserves whole graphemes and bounds %s", (_name, input, expected) => {
    const result = formatTextCell(input, 2);
    expect(result).toBe(expected);
    // The raw cap includes the ellipsis and every padding character.
    expect(result.length).toBeLessThanOrEqual(16);
  });
});
