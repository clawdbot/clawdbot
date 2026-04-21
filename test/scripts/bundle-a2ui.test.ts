import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareNormalizedPaths,
  getBundleHashInputPaths,
  getBundleHashRepoInputPaths,
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

  it("keeps unrelated repo dependency churn out of bundle hash inputs", () => {
    const repoRoot = path.resolve("repo-root");
    const inputPaths = getBundleHashRepoInputPaths(repoRoot);

    expect(inputPaths).toContain(path.join(repoRoot, "ui", "package.json"));
    expect(inputPaths).not.toContain(path.join(repoRoot, "package.json"));
    expect(inputPaths).not.toContain(path.join(repoRoot, "pnpm-lock.yaml"));
  });

  it("keeps local node_modules state out of bundle hash inputs", () => {
    const repoRoot = process.cwd();
    const inputPaths = getBundleHashInputPaths(repoRoot);

    expect(inputPaths).not.toContain(path.join(repoRoot, "package.json"));
    expect(inputPaths).not.toContain(path.join(repoRoot, "pnpm-lock.yaml"));
    expect(inputPaths).not.toContain(path.join(repoRoot, "node_modules", "lit", "package.json"));
    expect(inputPaths).not.toContain(
      path.join(repoRoot, "ui", "node_modules", "lit", "package.json"),
    );
  });
});
