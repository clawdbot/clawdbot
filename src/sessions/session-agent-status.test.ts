import { describe, expect, it } from "vitest";
import { normalizeSessionIconValue } from "./session-agent-status.js";

describe("normalizeSessionIconValue", () => {
  it.each([
    ["simple emoji", "🦞", "🦞"],
    ["trimmed emoji", "  🚀  ", "🚀"],
    ["ZWJ sequence", "👩‍💻", "👩‍💻"],
    ["flag emoji", "🇦🇹", "🇦🇹"],
    ["keycap sequence", "1️⃣", "1️⃣"],
    ["attention icon id", "hand", null],
    ["word", "hammer", null],
    ["CJK grapheme", "漢", null],
    ["accented letter", "ä", null],
    ["multiple characters", "ab", null],
    ["ASCII letter", "a", null],
    ["ASCII digit", "1", null],
    ["ASCII punctuation", "-", null],
    ["whitespace", " ", null],
    ["empty", "", null],
  ])("normalizes %s", (_label, input, expected) => {
    expect(normalizeSessionIconValue(input)).toBe(expected);
  });
});
