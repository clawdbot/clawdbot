// Text format tests cover command-facing shortening helpers.
import { describe, expect, it } from "vitest";
import { formatTextCell, shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("openclaw", 16)).toBe("openclaw");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenText("openclaw-status-output", 10)).toBe("openclaw-…");
  });

  it("returns an empty string for non-positive limits", () => {
    expect(shortenText("openclaw", 0)).toBe("");
    expect(shortenText("openclaw", -1)).toBe("");
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});

describe("formatTextCell raw output bound", () => {
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
