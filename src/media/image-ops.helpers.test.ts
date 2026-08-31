import { describe, expect, it } from "vitest";
import { buildImageResizeSideGrid, IMAGE_REDUCE_QUALITY_STEPS } from "./image-ops.js";

describe("buildImageResizeSideGrid", () => {
  it.each([
    { maxSide: 1200, sideStart: 900, expected: [1200, 1000, 900, 800] },
    { maxSide: 0, sideStart: 0, expected: [] },
  ] as const)(
    "builds resize grid for maxSide=$maxSide and sideStart=$sideStart",
    ({ maxSide, sideStart, expected }) => {
      expect(buildImageResizeSideGrid(maxSide, sideStart)).toEqual(expected);
    },
  );
});

describe("IMAGE_REDUCE_QUALITY_STEPS", () => {
  it("keeps expected quality ladder", () => {
    expect(IMAGE_REDUCE_QUALITY_STEPS).toEqual([85, 75, 65, 55, 45, 35]);
  });
});
