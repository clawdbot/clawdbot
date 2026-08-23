// Irc tests cover control chars plugin behavior.
import { describe, expect, it } from "vitest";
import { hasIrcControlChars, stripIrcControlChars } from "./control-chars.js";

describe("irc control char helpers", () => {
  it("detects IRC control characters without classifying spaces as control text", () => {
    expect(hasIrcControlChars("\u0000hello\u001f")).toBe(true);
    expect(hasIrcControlChars("hello\u007f")).toBe(true);
    expect(hasIrcControlChars("hello world")).toBe(false);
  });

  it("detects and strips IRC control characters from strings", () => {
    expect(hasIrcControlChars("hello\u0002world")).toBe(true);
    expect(hasIrcControlChars("hello world")).toBe(false);
    expect(stripIrcControlChars("he\u0002llo\u007f world")).toBe("hello world");
  });
});
