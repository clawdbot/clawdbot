import { describe, expect, it } from "vitest";
import { resolveCompactionTokenDecrease } from "./compaction-token-counts.js";

describe("resolveCompactionTokenDecrease", () => {
  it("returns a finite strict decrease", () => {
    expect(resolveCompactionTokenDecrease(999, 321)).toEqual({ before: 999, after: 321 });
    expect(resolveCompactionTokenDecrease(1, 0)).toEqual({ before: 1, after: 0 });
  });

  it.each([
    [0, 36],
    [20, 30],
    [36, 36],
    [undefined, 36],
    [36, undefined],
    [Number.NaN, 36],
    [36, Number.NaN],
    [Number.POSITIVE_INFINITY, 36],
    [36, Number.POSITIVE_INFINITY],
    [36, Number.NEGATIVE_INFINITY],
    [0, -1],
    [-1, -2],
  ])("rejects non-comparable counts %s -> %s", (before, after) => {
    expect(resolveCompactionTokenDecrease(before, after)).toBeUndefined();
  });
});
