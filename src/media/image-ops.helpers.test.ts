// Image operation helper tests cover dimension and format utility behavior.
import { describe, expect, it } from "vitest";
import { buildImageResizeSideGrid, IMAGE_REDUCE_QUALITY_STEPS } from "./image-ops.js";

describe("buildImageResizeSideGrid", () => {
  function expectImageResizeSideGridCase(width: number, height: number, expected: number[]) {
    expect(buildImageResizeSideGrid(width, height)).toEqual(expected);
  }

  it.each([
    { width: 1200, height: 900, expected: [1200, 1000, 900, 800] },
    { width: 0, height: 0, expected: [] },
  ] as const)("builds resize side grid for %ix%i", ({ width, height, expected }) => {
    expectImageResizeSideGridCase(width, height, [...expected]);
  });
});

describe("IMAGE_REDUCE_QUALITY_STEPS", () => {
  function expectQualityLadderCase(expectedQualityLadder: number[]) {
    expect([...IMAGE_REDUCE_QUALITY_STEPS]).toEqual(expectedQualityLadder);
  }

  it.each([
    {
      name: "keeps expected quality ladder",
      expectedQualityLadder: [85, 75, 65, 55, 45, 35],
    },
  ] as const)("$name", ({ expectedQualityLadder }) => {
    expectQualityLadderCase([...expectedQualityLadder]);
  });
});
