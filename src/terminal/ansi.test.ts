import { describe, expect, it } from "vitest";
import { sanitizeForLog, splitGraphemes, stripAnsi, visibleWidth } from "./ansi.js";

describe("terminal ansi helpers", () => {
  it("strips ANSI and OSC8 sequences", () => {
    expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red");
    expect(stripAnsi("\u001B[2K\u001B[1Ared")).toBe("red");
    expect(stripAnsi("\u001B]8;;https://openclaw.ai\u001B\\link\u001B]8;;\u001B\\")).toBe("link");
  });

  it("sanitizes control characters for log-safe interpolation", () => {
    const input =
      "\u001B[31mwarn\u001B[0m" +
      "\r\n" +
      "next" +
      String.fromCharCode(0) +
      "line" +
      String.fromCharCode(127);
    expect(sanitizeForLog(input)).toBe("warnnextline");
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
});
