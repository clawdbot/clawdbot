import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSbomRiskCheckErrors,
  collectSbomRiskReport,
  packageNameFromLockKey,
} from "../../scripts/sbom-risk-report.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-sbom-risk-"));
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

describe("collectSbomRiskReport", () => {
  it("reports root closure sizes, build-risk packages, and ownership gaps", () => {
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

    const report = collectSbomRiskReport({ repoRoot });

    expect(report.summary).toMatchObject({
      buildRiskPackageCount: 1,
      importerCount: 1,
      lockfilePackageCount: 4,
      rootClosurePackageCount: 4,
      rootDirectDependencyCount: 3,
      rootOwnershipRecordCount: 2,
    });
    expect(report.ownershipGaps).toEqual(["missing-owner"]);
    expect(report.topRootDependencyCones[0]).toMatchObject({
      closureSize: 3,
      name: "core-lib",
      owner: "core:test",
    });
    expect(collectSbomRiskCheckErrors(report)).toEqual([
      "root dependency 'missing-owner' is missing from scripts/lib/dependency-ownership.json",
    ]);
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

    const report = collectSbomRiskReport({ repoRoot });

    expect(report.ownershipGaps).toEqual([]);
    expect(report.staleOwnershipRecords).toEqual(["removed-lib"]);
  });
});
