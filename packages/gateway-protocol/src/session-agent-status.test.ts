import { describe, expect, it } from "vitest";
import {
  normalizeSessionIconValue,
  SESSION_AGENT_ATTENTION_ICON_IDS,
  SESSION_ICON_GLYPH_IDS,
} from "./session-agent-status.js";

const NORMALIZE_SESSION_ICON_CASES: ReadonlyArray<
  readonly [label: string, input: string, expected: string | null]
> = [
  ["simple emoji", "🦞", "🦞"],
  ["trimmed emoji", "  🚀  ", "🚀"],
  ["ZWJ sequence", "👩‍💻", "👩‍💻"],
  ["flag emoji", "🇦🇹", "🇦🇹"],
  ["keycap sequence", "1️⃣", "1️⃣"],
  ...SESSION_ICON_GLYPH_IDS.map((id) => [`${id} glyph`, id, id] as const),
  ...SESSION_AGENT_ATTENTION_ICON_IDS.map((id) => [`${id} attention id`, id, null] as const),
  ["word", "hammer", null],
  ["multiple characters", "ab", null],
  ["CJK grapheme", "漢", null],
  ["accented letter", "ä", null],
  ["ASCII letter", "a", null],
  ["ASCII digit", "1", null],
  ["ASCII punctuation", "-", null],
  ["whitespace", " ", null],
  ["empty", "", null],
];

describe("session icon grammar", () => {
  it.each(NORMALIZE_SESSION_ICON_CASES)("normalizes %s", (_label, input, expected) => {
    expect(normalizeSessionIconValue(input)).toBe(expected);
  });

  it("keeps persistent glyph ids disjoint from temporary attention ids", () => {
    const attentionIds = new Set<string>(SESSION_AGENT_ATTENTION_ICON_IDS);
    expect(SESSION_ICON_GLYPH_IDS.filter((id) => attentionIds.has(id))).toEqual([]);
  });
});
