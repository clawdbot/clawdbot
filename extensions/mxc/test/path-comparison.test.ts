import { describe, expect, test } from "vitest";
import { normalizeMxcPathForComparison } from "../src/path-comparison.js";

const describeOnWindows = describe.runIf(process.platform === "win32");

describeOnWindows("normalizeMxcPathForComparison", () => {
  test.each([
    [String.raw`\\?\C:\Workspace\Mixed\Case`, String.raw`\\?\c:\workspace\mixed\case`],
    [String.raw`\\?\UNC\Server\Share\Mixed\Case`, String.raw`\\?\unc\server\share\mixed\case`],
  ])("preserves the extended path prefix for %s", (input, expected) => {
    expect(normalizeMxcPathForComparison(input)).toBe(expected);
  });
});
