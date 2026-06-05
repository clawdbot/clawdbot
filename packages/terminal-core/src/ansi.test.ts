// Terminal Core tests cover ansi behavior.
import { describe, expect, it } from "vitest";
import {
  sanitizeForLog,
  splitGraphemes,
  stripAnsi,
  truncateToVisibleWidth,
  visibleWidth,
} from "./ansi.js";

describe("terminal ansi helpers", () => {
  it("strips ANSI and OSC8 sequences", () => {
    expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red");
    expect(stripAnsi("\u001B[2K\u001B[1Ared")).toBe("red");
    expect(stripAnsi("\u001B]8;;https://openclaw.ai\u001B\\link\u001B]8;;\u001B\\")).toBe("link");
    expect(stripAnsi("\u001B]8;;https://openclaw.ai\u0007link\u001B]8;;\u0007")).toBe("link");
    expect(stripAnsi("copy\u001B]52;c;YWJj\u0007safe")).toBe("copysafe");
  });

  it("sanitizes control characters for log-safe interpolation", () => {
    const input =
      "\u001B[31mwarn\u001B[0m" +
      "\r\n" +
      "next" +
      String.fromCharCode(0) +
      "line" +
      String.fromCharCode(127) +
      String.fromCharCode(0x9b) +
      "done";
    expect(sanitizeForLog(input)).toBe("warnnextlinedone");
  });

  it("measures wide graphemes by terminal cell width", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth("📸 skill")).toBe(8);
    expect(visibleWidth("表")).toBe(2);
    expect(visibleWidth("\u001B[31m📸\u001B[0m")).toBe(2);
  });

  it("keeps emoji zwj sequences as single graphemes", () => {
    expect(splitGraphemes("👨‍👩‍👧‍👦")).toEqual(["👨‍👩‍👧‍👦"]);
    expect(visibleWidth("👨‍👩‍👧‍👦")).toBe(2);
  });

  it("truncates to a visible-width budget without splitting wide graphemes", () => {
    expect(truncateToVisibleWidth("abc", 2)).toBe("ab");
    expect(truncateToVisibleWidth("abc", 5)).toBe("abc");
    expect(truncateToVisibleWidth("anything", 0)).toBe("");
    // A wide grapheme that cannot fit the remaining budget is dropped whole,
    // never emitted half-width, so the result never exceeds the budget.
    expect(truncateToVisibleWidth("表文", 2)).toBe("表");
    expect(truncateToVisibleWidth("表", 1)).toBe("");
    expect(visibleWidth(truncateToVisibleWidth("📸📸", 1))).toBeLessThanOrEqual(1);
  });

  it("preserves ANSI sequences when truncating styled text", () => {
    // Trailing reset is retained even when its grapheme is dropped, so the cell
    // does not bleed styling into surrounding padding.
    expect(truncateToVisibleWidth("[31mab[0m", 1)).toBe("[31ma[0m");
    expect(truncateToVisibleWidth("[31m表文[0m", 1)).toBe("[31m[0m");
    expect(visibleWidth(truncateToVisibleWidth("[31m表文[0m", 1))).toBe(0);
  });
});
