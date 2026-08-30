import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeSessionColorValue,
  normalizeSessionIconValue,
  SESSION_AGENT_ATTENTION_ICON_IDS,
  SESSION_COLOR_IDS,
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

describe("session color grammar", () => {
  it.each([
    ...SESSION_COLOR_IDS.map((id) => [`${id} color`, id, id] as const),
    ["trimmed uppercase", "  Blue ", "blue"],
    // Claude Code /color treats these as clear values, never stored colors.
    ["claude clear alias default", "default", null],
    ["claude clear alias gray", "gray", null],
    ["claude clear alias grey", "grey", null],
    ["hex value", "#ff5c5c", null],
    ["word", "crimson", null],
    ["empty", "", null],
    ["whitespace", " ", null],
  ] as ReadonlyArray<readonly [label: string, input: string, expected: string | null]>)(
    "normalizes %s",
    (_label, input, expected) => {
      expect(normalizeSessionColorValue(input)).toBe(expected);
    },
  );
});

describe("session icon grammar without Unicode Sets support", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("loads and falls back to the grapheme heuristic when the v flag throws", async () => {
    const NativeRegExp = RegExp;
    // Mimic a pre-Unicode-Sets browser engine: `v`-flag construction throws.
    const ThrowingRegExp = function (this: unknown, pattern: string, flags?: string) {
      if (flags?.includes("v")) {
        throw new SyntaxError("Invalid flags supplied to RegExp constructor 'v'");
      }
      return new NativeRegExp(pattern, flags);
    } as unknown as RegExpConstructor;
    vi.stubGlobal("RegExp", ThrowingRegExp);
    vi.resetModules();

    const fallback = await import("./session-agent-status.js");
    expect(fallback.normalizeSessionIconValue("🦞")).toBe("🦞");
    expect(fallback.normalizeSessionIconValue("braces")).toBe("braces");
    expect(fallback.normalizeSessionIconValue("hammer")).toBeNull();
    expect(fallback.normalizeSessionIconValue("a")).toBeNull();
    // Known heuristic looseness on such engines: single non-ASCII text graphemes
    // pass client pre-validation; the Gateway still rejects them exactly.
    expect(fallback.normalizeSessionIconValue("漢")).toBe("漢");
  });
});
