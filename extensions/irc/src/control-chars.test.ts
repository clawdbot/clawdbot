import { describe, expect, it } from "vitest";
import { hasIrcControlChars, isIrcControlChar, stripIrcControlChars } from "./control-chars.js";

describe("irc control char helpers", () => {
  it("detects IRC control characters by codepoint", () => {
    expect(isIrcControlChar(0x00)).toBe(true);
    expect(isIrcControlChar(0x1f)).toBe(true);
    expect(isIrcControlChar(0x7f)).toBe(true);
    expect(isIrcControlChar(0x20)).toBe(false);
  });

  it("detects and strips IRC control characters from strings", () => {
    expect(hasIrcControlChars("hello\u0002world")).toBe(true);
    expect(hasIrcControlChars("hello world")).toBe(false);
    expect(stripIrcControlChars("he\u0002llo\u007f world")).toBe("hello world");
  });
});
