import { describe, expect, it } from "vitest";
import { codePointCountExceeds, countCodePoints, sliceCodePoints } from "./code-points.js";

// The replaced call sites all computed through this materialized form; every
// helper must match it exactly, including on surrogate-heavy and broken input.
const SAMPLES = [
  "",
  "a",
  "plain ascii text",
  "é",
  "é",
  "👍",
  "a👍b",
  "👨‍👩‍👧‍👦",
  "🇹🇼🇯🇵",
  "𝕏𝕐𝕑",
  "mixed 中文 and 👍🏽 tone",
  "\ud83d",
  "a\ud83d",
  "\ude00b",
  "😀\ud83d",
];

describe("countCodePoints", () => {
  it.each(SAMPLES.map((text) => [text]))("matches Array.from length for %j", (text) => {
    expect(countCodePoints(text)).toBe(Array.from(text).length);
  });
});

describe("codePointCountExceeds", () => {
  it("matches the materialized comparison across limits", () => {
    for (const text of SAMPLES) {
      const total = Array.from(text).length;
      for (const limit of [0, 1, 2, total - 1, total, total + 1, text.length]) {
        expect(codePointCountExceeds(text, limit)).toBe(total > limit);
      }
    }
  });

  it("never exceeds when the UTF-16 length already fits the limit", () => {
    // The fast path relies on code points never outnumbering UTF-16 units.
    expect(codePointCountExceeds("👍👍", 4)).toBe(false);
    expect(codePointCountExceeds("👍👍", 2)).toBe(false);
    expect(codePointCountExceeds("👍👍", 1)).toBe(true);
  });

  it("stops at the first excess character", () => {
    let highestUnitRead = 0;
    const text = {
      length: 100,
      charCodeAt(index: number) {
        highestUnitRead = Math.max(highestUnitRead, index + 1);
        return 0x78;
      },
    } as unknown as string;
    expect(codePointCountExceeds(text, 3)).toBe(true);
    // One BMP character per unit: excess is detected on the fourth count before
    // the walker ever reads a fourth unit.
    expect(highestUnitRead).toBe(3);
  });
});

describe("sliceCodePoints", () => {
  it("matches the materialized slice across argument shapes", () => {
    for (const text of SAMPLES) {
      const total = Array.from(text).length;
      const bounds = [
        0,
        1,
        2,
        total - 1,
        total,
        total + 2,
        -1,
        -2,
        -(total + 1),
        // Array.prototype.slice coerces these via ToIntegerOrInfinity; the walker must match.
        1.5,
        -1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ];
      for (const start of bounds) {
        expect(sliceCodePoints(text, start)).toBe(Array.from(text).slice(start).join(""));
        for (const end of bounds) {
          expect(sliceCodePoints(text, start, end)).toBe(
            Array.from(text).slice(start, end).join(""),
          );
        }
      }
    }
  });
});
