import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareNormalizedPaths,
  getBundleHashInputPaths,
  getBundleHashRepoInputPaths,
  getLocalRolldownCliCandidates,
  getResolvedBundleDependencyPackageJsonPaths,
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

  it("keeps repo-root package churn out of bundle hash inputs", () => {
    const repoRoot = path.resolve("repo-root");
    const inputPaths = getBundleHashRepoInputPaths(repoRoot);

    expect(inputPaths).toContain(path.join(repoRoot, "ui", "package.json"));
    expect(inputPaths).not.toContain(path.join(repoRoot, "package.json"));
    expect(inputPaths).not.toContain(path.join(repoRoot, "pnpm-lock.yaml"));
  });

  it("tracks only the resolved bundle dependency manifests from node_modules", () => {
    const repoRoot = process.cwd();
    const dependencyPaths = getResolvedBundleDependencyPackageJsonPaths(repoRoot);
    const relativeDependencyPaths = dependencyPaths.map((dependencyPath) =>
      path.relative(repoRoot, dependencyPath).replaceAll(path.sep, "/"),
    );

    expect(
      relativeDependencyPaths.map((relativePath) => relativePath.replace(/^ui\//u, "")),
    ).toEqual([
      path.posix.join("node_modules", "lit", "package.json"),
      path.posix.join("node_modules", "@lit/context", "package.json"),
      path.posix.join("node_modules", "@lit-labs/signals", "package.json"),
      path.posix.join("node_modules", "signal-utils", "package.json"),
    ]);
    expect(
      relativeDependencyPaths.every((relativePath) => /^(ui\/)?node_modules\//u.test(relativePath)),
    ).toBe(true);
    expect(getBundleHashInputPaths(repoRoot)).not.toContain(path.join(repoRoot, "package.json"));
    expect(getBundleHashInputPaths(repoRoot)).not.toContain(path.join(repoRoot, "pnpm-lock.yaml"));
  });
});
