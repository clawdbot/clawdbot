import { describe, expect, it } from "vitest";
import { resolveCompactionTokenDecrease } from "./compaction-token-counts.js";

describe("resolveCompactionTokenDecrease", () => {
  it("returns a finite strict decrease", () => {
    expect(resolveCompactionTokenDecrease(999, 321)).toEqual({ before: 999, after: 321 });
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
  ])("rejects non-comparable counts %s -> %s", (before, after) => {
    expect(resolveCompactionTokenDecrease(before, after)).toBeUndefined();
  });
});
