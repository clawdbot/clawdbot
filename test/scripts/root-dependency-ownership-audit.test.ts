import { describe, expect, it } from "vitest";
import {
  classifyRootDependencyOwnership,
  collectModuleSpecifiers,
} from "../../scripts/root-dependency-ownership-audit.mjs";

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
