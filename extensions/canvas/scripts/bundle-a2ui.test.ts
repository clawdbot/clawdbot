import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareNormalizedPaths,
  getBundleHashInputPaths,
  getBundleHashRepoInputPaths,
  getLocalRolldownCliCandidates,
  isBundleHashInputPath,
} from "./bundle-a2ui.mjs";

describe("scripts/bundle-a2ui.mjs", () => {
  it("uses package metadata and plugin-owned A2UI sources as bundle hash inputs", () => {
    const repoRoot = path.resolve("repo-root");
    const inputPaths = getBundleHashRepoInputPaths(repoRoot);

    expect(inputPaths).toContain(path.join(repoRoot, "package.json"));
    expect(inputPaths).toContain(path.join(repoRoot, "pnpm-lock.yaml"));
    expect(inputPaths).toContain(
      path.join(repoRoot, "extensions", "canvas", "src", "host", "a2ui-app"),
    );
    expect(inputPaths).not.toContain(path.join(repoRoot, "vendor", "a2ui", "renderers", "lit"));
    expect(isBundleHashInputPath(path.join(repoRoot, "package.json"), repoRoot)).toBe(true);
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

  it("keeps unrelated package metadata out of bundle hash inputs", () => {
    const repoRoot = path.resolve("repo-root");
    const inputPaths = getBundleHashRepoInputPaths(repoRoot);

    expect(inputPaths).not.toContain(path.join(repoRoot, "ui", "package.json"));
    expect(inputPaths).not.toContain(path.join(repoRoot, "packages", "plugin-sdk", "package.json"));
  });

  it("keeps local node_modules state out of bundle hash inputs", () => {
    const repoRoot = process.cwd();
    const inputPaths = getBundleHashInputPaths(repoRoot);

    expect(inputPaths).not.toContain(path.join(repoRoot, "node_modules", "lit", "package.json"));
    expect(inputPaths).not.toContain(
      path.join(repoRoot, "ui", "node_modules", "lit", "package.json"),
    );
  });
});
