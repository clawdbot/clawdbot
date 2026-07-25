// Model list formatting tests cover fixed-width terminal cell helpers.
import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import { pad, truncate } from "./list.format.js";

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

describe("pad", () => {
  it("pads to terminal visible width rather than string length", () => {
    expect(pad("表", 2)).toBe("表");
    expect(pad("表", 3)).toBe("表 ");
  });
});
