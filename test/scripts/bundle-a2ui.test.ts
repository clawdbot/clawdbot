import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareNormalizedPaths,
  getLocalRolldownCliCandidates,
  isBundleHashInputPath,
} from "../../scripts/bundle-a2ui.mjs";

describe("scripts/bundle-a2ui.mjs", () => {
  it("keeps generated renderer output out of bundle hash inputs", () => {
    const repoRoot = path.resolve("repo-root");

    expect(
      isBundleHashInputPath(
        path.join(repoRoot, "vendor", "a2ui", "renderers", "lit", "src", "index.ts"),
        repoRoot,
      ),
    ).toBe(true);
    expect(
      isBundleHashInputPath(
        path.join(repoRoot, "vendor", "a2ui", "renderers", "lit", "dist"),
        repoRoot,
      ),
    ).toBe(false);
    expect(
      isBundleHashInputPath(
        path.join(repoRoot, "vendor", "a2ui", "renderers", "lit", "dist", "src", "index.js"),
        repoRoot,
      ),
    ).toBe(false);
  });

  it("prefers the installed rolldown CLI over a network dlx fallback", () => {
    const repoRoot = path.resolve("repo-root");

    expect(getLocalRolldownCliCandidates(repoRoot)[0]).toBe(
      path.join(repoRoot, "node_modules", "rolldown", "bin", "cli.mjs"),
    );
  });

  it("sorts hash inputs without locale-dependent collation", () => {
    const paths = ["repo/Z.ts", "repo/a.ts", "repo/ä.ts", "repo/A.ts"];

    expect([...paths].toSorted(compareNormalizedPaths)).toEqual([
      "repo/A.ts",
      "repo/Z.ts",
      "repo/a.ts",
      "repo/ä.ts",
    ]);
  });
});
