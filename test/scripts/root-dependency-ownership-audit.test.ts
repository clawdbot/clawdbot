import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRootDependencyOwnership,
  collectRootDependencyOwnershipAudit,
  collectRootDependencyOwnershipCheckErrors,
  collectModuleSpecifiers,
} from "../../scripts/root-dependency-ownership-audit.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeTempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-root-deps-audit-"));
  tempDirs.push(dir);
  return dir;
}

function writeRepoFile(repoRoot: string, relativePath: string, value: string) {
  const filePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

describe("collectModuleSpecifiers", () => {
  it("captures require.resolve package lookups used by runtime shims and bundled plugins", () => {
    expect([
      ...collectModuleSpecifiers(`
        const require = createRequire(import.meta.url);
        const runtimeRequire = createRequire(runtimePackagePath);
        require.resolve("gaxios");
        runtimeRequire.resolve("openshell/package.json");
      `),
    ]).toEqual(["gaxios", "openshell/package.json"]);
  });
});

describe("classifyRootDependencyOwnership", () => {
  it("treats root-dist bundled runtime imports as localizable extension deps", () => {
    expect(
      classifyRootDependencyOwnership({
        sections: ["extensions"],
        rootMirrorImporters: ["discovery-DZDwKJdJ.js"],
      }),
    ).toEqual({
      category: "extension_only_localizable",
      recommendation:
        "remove from root package.json and rely on owning extension manifests plus doctor --fix",
    });
  });

  it("treats scripts and tests as dev-only candidates", () => {
    expect(
      classifyRootDependencyOwnership({
        sections: ["scripts", "test"],
        rootMirrorImporters: [],
      }),
    ).toEqual({
      category: "script_or_test_only",
      recommendation: "consider moving from dependencies to devDependencies",
    });
  });

  it("treats extension-only deps as localizable when no root mirror exists", () => {
    expect(
      classifyRootDependencyOwnership({
        sections: ["extensions", "test"],
        rootMirrorImporters: [],
      }),
    ).toEqual({
      category: "extension_only_localizable",
      recommendation:
        "remove from root package.json and rely on owning extension manifests plus doctor --fix",
    });
  });

  it("treats src-owned deps as core runtime", () => {
    expect(
      classifyRootDependencyOwnership({
        sections: ["src"],
        rootMirrorImporters: [],
      }),
    ).toEqual({
      category: "core_runtime",
      recommendation: "keep at root",
    });
  });

  it("treats unreferenced deps as removal candidates", () => {
    expect(
      classifyRootDependencyOwnership({
        sections: [],
        rootMirrorImporters: [],
      }),
    ).toEqual({
      category: "unreferenced",
      recommendation: "investigate removal; no direct source imports found in scanned files",
    });
  });
});

describe("collectRootDependencyOwnershipCheckErrors", () => {
  it("catches dependencies mirrored at root but only imported by one extension", () => {
    const repoRoot = makeTempRepo();
    writeRepoFile(
      repoRoot,
      "package.json",
      JSON.stringify({ dependencies: { "vendor-sdk": "^1.0.0" } }),
    );
    writeRepoFile(
      repoRoot,
      "extensions/qqbot/package.json",
      JSON.stringify({ dependencies: { "vendor-sdk": "^1.0.0" } }),
    );
    writeRepoFile(
      repoRoot,
      "extensions/qqbot/src/setup.ts",
      'const sdk = await import("vendor-sdk");\n',
    );

    const records = collectRootDependencyOwnershipAudit({ repoRoot, scanRoots: ["extensions"] });

    expect(collectRootDependencyOwnershipCheckErrors(records)).toEqual([
      "root dependency 'vendor-sdk' is extension-owned (remove from root package.json and rely on owning extension manifests plus doctor --fix); extension declarations: qqbot:dependencies; sample imports: extensions/qqbot/src/setup.ts",
    ]);
  });

  it("fails only extension-owned root dependencies", () => {
    expect(
      collectRootDependencyOwnershipCheckErrors([
        {
          category: "extension_only_localizable",
          declaredInExtensions: ["qqbot:dependencies"],
          depName: "@tencent-connect/qqbot-connector",
          recommendation:
            "remove from root package.json and rely on owning extension manifests plus doctor --fix",
          sampleFiles: ["extensions/qqbot/src/bridge/setup/finalize.ts"],
        },
        {
          category: "unreferenced",
          declaredInExtensions: [],
          depName: "@mozilla/readability",
          recommendation: "investigate removal; no direct source imports found in scanned files",
          sampleFiles: [],
        },
      ]),
    ).toEqual([
      "root dependency '@tencent-connect/qqbot-connector' is extension-owned (remove from root package.json and rely on owning extension manifests plus doctor --fix); extension declarations: qqbot:dependencies; sample imports: extensions/qqbot/src/bridge/setup/finalize.ts",
    ]);
  });
});
