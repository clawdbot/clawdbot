// Chunk items tests cover fixed-size array splitting edge cases.
import { describe, expect, it } from "vitest";
import { chunkItems } from "./chunk-items.js";

describe("chunkItems", () => {
  it("splits items into fixed-size chunks", () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkItems(["a", "b", "c", "d"], 3)).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("returns a single chunk when size is 0 or negative", () => {
    expect(chunkItems([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(chunkItems([1, 2, 3], -1)).toEqual([[1, 2, 3]]);
  });

  it("returns empty array for empty input", () => {
    expect(chunkItems([], 5)).toEqual([]);
    expect(chunkItems([], 0)).toEqual([[]]);
    expect(chunkItems([], -1)).toEqual([[]]);
  });

  it("wraps each item when size is 1", () => {
    expect(chunkItems([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it("returns a single chunk when size exceeds array length", () => {
    expect(chunkItems([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("exactly divides when size matches array length", () => {
    expect(chunkItems([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("preserves readonly input without mutation", () => {
    const input: readonly number[] = [10, 20, 30, 40];
    const result = chunkItems(input, 2);
    expect(result).toEqual([
      [10, 20],
      [30, 40],
    ]);
    expect(input).toEqual([10, 20, 30, 40]);
  });

  it("handles fractional size using slice native truncation behavior", () => {
    // slice() truncates non-integer args, so 2.5 → chunk boundaries at 0, 2.5, 5.0
    expect(chunkItems([1, 2, 3, 4, 5], 2.5)).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });
});
