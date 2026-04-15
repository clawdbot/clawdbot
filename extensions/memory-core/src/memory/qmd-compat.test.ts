import { describe, expect, it } from "vitest";
import { resolveQmdCollectionPatternFlags } from "./qmd-compat.js";

describe("resolveQmdCollectionPatternFlags", () => {
  it("prefers modern --glob by default and falls back to legacy --mask", () => {
    expect(resolveQmdCollectionPatternFlags(null)).toEqual(["--glob", "--mask"]);
    expect(resolveQmdCollectionPatternFlags("--glob")).toEqual(["--glob", "--mask"]);
  });

  it("keeps preferring legacy --mask after a legacy-only qmd succeeds", () => {
    expect(resolveQmdCollectionPatternFlags("--mask")).toEqual(["--mask", "--glob"]);
  });
});
