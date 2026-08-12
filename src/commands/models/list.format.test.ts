// Model list formatting tests cover fixed-width terminal cell helpers.
import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import { formatTokenK, padTerminalCell, truncate } from "./list.format.js";

describe("formatTokenK", () => {
  it("renders token context windows in decimal K", () => {
    expect(formatTokenK(200_000)).toBe("200k");
    expect(formatTokenK(128_000)).toBe("128k");
    expect(formatTokenK(1_000_000)).toBe("1000k");
    expect(formatTokenK(195_000)).toBe("195k");
  });

  it("passes small counts through and switches to K at 1000", () => {
    expect(formatTokenK(999)).toBe("999");
    expect(formatTokenK(1_000)).toBe("1k");
  });

  it("returns a dash for missing or non-finite values", () => {
    expect(formatTokenK(undefined)).toBe("-");
    expect(formatTokenK(null)).toBe("-");
    expect(formatTokenK(0)).toBe("-");
    expect(formatTokenK(Number.NaN)).toBe("-");
  });
});

describe("truncate", () => {
  it("preserves existing ASCII truncation with an ellipsis suffix", () => {
    expect(truncate("abcdefghi", 6)).toBe("abc...");
  });

  it("keeps ellipsis-suffixed truncation on a terminal-width boundary", () => {
    const grin = String.fromCodePoint(0x1f600);
    const result = truncate(`ab${grin}cde`, 6);

    expect(result).toBe("ab...");
    expect(visibleWidth(result)).toBe(5);
  });

  it("drops an over-wide grapheme when the budget is too small", () => {
    const grin = String.fromCodePoint(0x1f600);
    const result = truncate(grin, 1);

    expect(result).toBe("");
  });

  it("sanitizes terminal controls before measuring visible width", () => {
    expect(truncate("ab\u001B]2;hidden\u0007cd", 6)).toBe("abcd");
  });
});

describe("padTerminalCell", () => {
  it("pads to terminal visible width rather than string length", () => {
    expect(padTerminalCell("表", 2)).toBe("表");
    expect(padTerminalCell("表", 3)).toBe("表 ");
  });
});
