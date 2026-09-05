// Verifies bundled capability metadata emitted by plugins.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";

function listGitExtensionPackagePaths(extensionsDir: string): string[] | null {
  const relativeDir = toRepoRelativePath(repoRoot, extensionsDir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const files = listGitTrackedFiles({ repoRoot, pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => /^extensions\/[^/]+\/package\.json$/u.test(line))
    .map((line) => path.join(repoRoot, ...line.split("/")))
    .toSorted();
}

function listExtensionPackagePaths(extensionsDir: string): string[] {
  const gitPaths = listGitExtensionPackagePaths(extensionsDir);
  if (gitPaths) {
    return gitPaths;
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extensionsDir, entry.name, "package.json"))
    .filter((packagePath) => fs.existsSync(packagePath));
}

describe("bundled capability metadata", () => {
  it("lists bundled extension packages from git without scanning extension dirs", () => {
    const extensionsDir = path.join(repoRoot, "extensions");
    expectNoReaddirSyncDuring(() => {
      const packagePaths = listExtensionPackagePaths(extensionsDir);

      expect(packagePaths.length).toBeGreaterThan(0);
      expect(packagePaths.every((file) => file.endsWith("package.json"))).toBe(true);
    });
  });
});
