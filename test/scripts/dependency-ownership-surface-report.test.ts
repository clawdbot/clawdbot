import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectDependencyOwnershipSurfaceCheckErrors,
  collectDependencyOwnershipSurfaceReport,
  packageNameFromLockKey,
  renderDependencyOwnershipSurfaceMarkdownReport,
} from "../../scripts/dependency-ownership-surface-report.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-ownership-surface-"));
  tempDirs.push(dir);
  return dir;
}

function writeRepoFile(repoRoot: string, relativePath: string, value: string) {
  const filePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

describe("packageNameFromLockKey", () => {
  it("extracts scoped and unscoped names from pnpm snapshot keys", () => {
    expect(packageNameFromLockKey("@scope/pkg@1.2.3(peer@1.0.0)")).toBe("@scope/pkg");
    expect(packageNameFromLockKey("left-pad@1.3.0")).toBe("left-pad");
  });
});

describe("collectDependencyOwnershipSurfaceReport", () => {
  it("reports root dependency reachability, install-surface packages, and ownership metadata gaps", () => {
    const repoRoot = makeTempRepo();
    writeRepoFile(
      repoRoot,
      "package.json",
      JSON.stringify({
        dependencies: {
          "core-lib": "1.0.0",
          "missing-owner": "2.0.0",
        },
      }),
    );
    writeRepoFile(
      repoRoot,
      "pnpm-lock.yaml",
      `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      core-lib:
        specifier: 1.0.0
        version: 1.0.0
      missing-owner:
        specifier: 2.0.0
        version: 2.0.0
      alias-domexception:
        specifier: npm:@nolyfill/domexception@1.0.0
        version: npm:@nolyfill/domexception@1.0.0
packages:
  core-lib@1.0.0: {}
  transitive-native@1.0.0:
    requiresBuild: true
  missing-owner@2.0.0: {}
  '@nolyfill/domexception@1.0.0': {}
snapshots:
  core-lib@1.0.0:
    dependencies:
      transitive-native: 1.0.0
      alias-domexception: '@nolyfill/domexception@1.0.0'
  transitive-native@1.0.0: {}
  missing-owner@2.0.0: {}
  '@nolyfill/domexception@1.0.0': {}
`,
    );
    writeRepoFile(
      repoRoot,
      "scripts/lib/dependency-ownership.json",
      JSON.stringify({
        schemaVersion: 1,
        dependencies: {
          "alias-domexception": {
            owner: "core:test",
            class: "core-runtime",
            risk: ["compat"],
          },
          "core-lib": { owner: "core:test", class: "core-runtime", risk: ["network"] },
        },
      }),
    );
    writeRepoFile(repoRoot, "src/index.ts", 'import "core-lib";\n');

    const report = collectDependencyOwnershipSurfaceReport({ repoRoot });

    expect(report.summary).toEqual({
      buildRiskPackageCount: 1,
      importerCount: 1,
      lockfilePackageCount: 4,
      rootClosurePackageCount: 4,
      rootDirectDependencyCount: 3,
      rootOwnershipRecordCount: 2,
    });
    expect(report.ownershipGaps).toEqual(["missing-owner"]);
    expect(report.topRootDependencyCones[0]).toEqual({
      class: "core-runtime",
      closureSize: 3,
      missingSnapshotKeys: [],
      name: "core-lib",
      owner: "core:test",
      resolved: "1.0.0",
      risk: ["network"],
      section: "dependencies",
      sourceCategory: "unreferenced",
      sourceFileCount: 0,
      sourceSections: [],
      specifier: "1.0.0",
    });
    expect(collectDependencyOwnershipSurfaceCheckErrors(report)).toEqual([
      "root dependency 'missing-owner' is missing from scripts/lib/dependency-ownership.json",
    ]);

    const markdown = renderDependencyOwnershipSurfaceMarkdownReport(report);
    expect(markdown).toContain("# Dependency Ownership and Install Surface Report");
    expect(markdown).toContain("## Target");
    expect(markdown).toContain("## Scope");
    expect(markdown).toContain("It does not query npm advisories");
    expect(markdown).toContain("## Root Dependencies Missing Ownership Metadata");
    expect(markdown).toContain("`missing-owner`");
    expect(markdown).toContain("## Root Dependencies By Resolved Transitive Package Count");
    expect(markdown).toContain("`core-lib`: 3 resolved transitive packages");
    expect(markdown).toContain("## Workspace Packages With The Most Dependencies");
    expect(markdown).toContain("3 direct dependencies");
    expect(markdown).not.toContain("dependencys");
    expect(markdown).toContain("## Packages With Install-Time Or Platform-Specific Behavior");
    expect(markdown).toContain("`transitive-native@1.0.0`: requires build");
    expect(markdown).not.toContain("# Dependency Risk Report");
    expect(markdown).not.toContain("Ownership gaps");
    expect(markdown).not.toContain("Largest root dependency cones");
    expect(markdown).not.toContain("## Root Dependencies With The Most Transitive Packages");
  });

  it("does not mark plugin importer dependencies as stale ownership records", () => {
    const repoRoot = makeTempRepo();
    writeRepoFile(
      repoRoot,
      "package.json",
      JSON.stringify({
        dependencies: {
          "core-lib": "1.0.0",
        },
      }),
    );
    writeRepoFile(
      repoRoot,
      "pnpm-lock.yaml",
      `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      core-lib:
        specifier: 1.0.0
        version: 1.0.0
  extensions/web-readability:
    dependencies:
      plugin-readable:
        specifier: 2.0.0
        version: 2.0.0
packages:
  core-lib@1.0.0: {}
  plugin-readable@2.0.0: {}
snapshots:
  core-lib@1.0.0: {}
  plugin-readable@2.0.0: {}
`,
    );
    writeRepoFile(
      repoRoot,
      "scripts/lib/dependency-ownership.json",
      JSON.stringify({
        schemaVersion: 1,
        dependencies: {
          "core-lib": { owner: "core:test", class: "core-runtime", risk: ["network"] },
          "plugin-readable": {
            owner: "plugin:web-readability",
            class: "plugin-runtime",
            risk: ["html"],
          },
          "removed-lib": { owner: "core:test", class: "core-runtime", risk: ["unused"] },
        },
      }),
    );

    const report = collectDependencyOwnershipSurfaceReport({ repoRoot });

    expect(report.ownershipGaps).toStrictEqual([]);
    expect(report.staleOwnershipRecords).toEqual(["removed-lib"]);
  });
});
