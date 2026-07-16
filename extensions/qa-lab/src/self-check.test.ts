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
    expect(resolveQaSelfCheckOutputPath({ repoRoot: "/tmp/openclaw-repo" })).toBe(
      "/tmp/openclaw-repo/.artifacts/qa-e2e/self-check.md",
    );
  });
});
