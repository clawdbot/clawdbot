import { describe, expect, it } from "vitest";
import { parseArgs, resolveMergeHeadDiffBase } from "../../scripts/lib/merge-head-diff-base.mjs";

describe("merge-head-diff-base", () => {
  it("parses explicit refs", () => {
    expect(parseArgs(["--base", "origin/main", "--head", "HEAD"])).toEqual({
      base: "origin/main",
      head: "HEAD",
      preferFirstParent: false,
    });
  });

  it("rejects missing refs", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--head"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--base", ""])).toThrow("--base requires a value");
  });

  it("keeps empty base resolution as the no-op programmatic default", () => {
    expect(resolveMergeHeadDiffBase({ base: "", preferFirstParent: true })).toBe("");
  });
});
