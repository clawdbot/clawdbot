import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveQaSelfCheckOutputPath } from "./self-check.js";

describe("resolveQaSelfCheckOutputPath", () => {
  it("keeps explicit output paths untouched", () => {
    expect(
      resolveQaSelfCheckOutputPath({
        repoRoot: "/tmp/openclaw-repo",
        outputPath: "/tmp/custom/self-check.md",
      }),
    ).toBe("/tmp/custom/self-check.md");
  });

  it("anchors default self-check reports under the provided repo root", () => {
    const repoRoot = path.resolve("/tmp/openclaw-repo");
    expect(resolveQaSelfCheckOutputPath({ repoRoot })).toBe(
      path.join(repoRoot, ".artifacts", "qa-e2e", "self-check.md"),
    );
  });
});
