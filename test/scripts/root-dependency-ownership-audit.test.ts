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

  it("resolves simple string constants used by lazy runtime imports", () => {
    expect([
      ...collectModuleSpecifiers(`
        const READABILITY_MODULE = "@mozilla/readability";
        const PDFJS_MODULE = "pdfjs-dist/legacy/build/pdf.mjs";
        const CIAO_MODULE_ID = "@homebridge/ciao";
        let SQLITE_VEC_MODULE_ID = "sqlite-vec";
        import(READABILITY_MODULE);
        import(PDFJS_MODULE);
        require(CIAO_MODULE_ID);
        require.resolve(SQLITE_VEC_MODULE_ID);
      `),
    ]).toEqual([
      "@mozilla/readability",
      "pdfjs-dist/legacy/build/pdf.mjs",
      "@homebridge/ciao",
      "sqlite-vec",
    ]);
  });
});

describe("classifyRootDependencyOwnership", () => {
  it("treats scripts and tests as dev-only candidates", () => {
    expect(
      classifyRootDependencyOwnership({
        sections: ["scripts", "test"],
      }),
    ).toEqual({
      category: "script_or_test_only",
      recommendation: "consider moving from dependencies to devDependencies",
    });
  });

  it("treats extension-only deps as localizable", () => {
    expect(
      classifyRootDependencyOwnership({
        depName: "vendor-sdk",
        sections: ["extensions", "test"],
      }),
    ).toEqual({
      category: "extension_only_localizable",
      recommendation:
        "remove from root package.json and rely on owning extension manifests plus doctor --fix",
    });
  });

  it("allows explicit root-owned internal extension runtime dependencies", () => {
    expect(
      classifyRootDependencyOwnership({
        depName: "playwright-core",
        sections: ["extensions", "test"],
      }),
    ).toEqual({
      category: "root_owned_extension_runtime",
      recommendation:
        "keep at root; the internal browser runtime is shipped with core even though downloadable browser-adjacent plugins also declare it",
    });
  });

  it("treats src-owned deps as core runtime", () => {
    expect(
      classifyRootDependencyOwnership({
        sections: ["src"],
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

  it("classifies root dependencies referenced through constant dynamic imports", () => {
    const repoRoot = makeTempRepo();
    writeRepoFile(
      repoRoot,
      "package.json",
      JSON.stringify({ dependencies: { "pdfjs-dist": "^5.0.0", "sqlite-vec": "0.1.9" } }),
    );
    writeRepoFile(
      repoRoot,
      "src/media/pdf-extract.ts",
      `
        const PDFJS_MODULE = "pdfjs-dist/legacy/build/pdf.mjs";
        export async function loadPdf() {
          return import(PDFJS_MODULE);
        }
      `,
    );
    writeRepoFile(
      repoRoot,
      "packages/memory-host-sdk/src/host/sqlite-vec.ts",
      `
        const SQLITE_VEC_MODULE_ID = "sqlite-vec";
        export async function loadSqliteVecModule() {
          return import(SQLITE_VEC_MODULE_ID);
        }
      `,
    );

    const records = collectRootDependencyOwnershipAudit({
      repoRoot,
      scanRoots: ["src", "packages"],
    });

    expect(records).toEqual([
      {
        category: "core_runtime",
        declaredInExtensions: [],
        depName: "pdfjs-dist",
        fileCount: 1,
        internalizedBundledRuntimeOwners: [],
        recommendation: "keep at root",
        sampleFiles: ["src/media/pdf-extract.ts"],
        sections: ["src"],
        spec: "^5.0.0",
      },
      {
        category: "core_runtime",
        declaredInExtensions: [],
        depName: "sqlite-vec",
        fileCount: 1,
        internalizedBundledRuntimeOwners: [],
        recommendation: "keep at root",
        sampleFiles: ["packages/memory-host-sdk/src/host/sqlite-vec.ts"],
        sections: ["packages"],
        spec: "0.1.9",
      },
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

  it("does not fail explicitly root-owned internal extension runtime dependencies", () => {
    const repoRoot = makeTempRepo();
    writeRepoFile(
      repoRoot,
      "package.json",
      JSON.stringify({
        dependencies: { "@homebridge/ciao": "^1.3.7", "playwright-core": "1.59.1" },
      }),
    );
    writeRepoFile(
      repoRoot,
      "extensions/bonjour/package.json",
      JSON.stringify({ dependencies: { "@homebridge/ciao": "^1.3.7" } }),
    );
    writeRepoFile(
      repoRoot,
      "extensions/bonjour/src/advertiser.ts",
      'const CIAO_MODULE_ID = "@homebridge/ciao";\nimport(CIAO_MODULE_ID);\n',
    );
    writeRepoFile(
      repoRoot,
      "extensions/browser/package.json",
      JSON.stringify({ dependencies: { "playwright-core": "1.59.1" } }),
    );
    writeRepoFile(
      repoRoot,
      "extensions/browser/src/browser/playwright-core.runtime.ts",
      'const runtime = require("playwright-core");\n',
    );

    const records = collectRootDependencyOwnershipAudit({ repoRoot, scanRoots: ["extensions"] });

    expect(records).toEqual([
      {
        category: "root_owned_extension_runtime",
        declaredInExtensions: ["bonjour:dependencies"],
        depName: "@homebridge/ciao",
        fileCount: 1,
        internalizedBundledRuntimeOwners: [],
        recommendation:
          "keep at root; the Bonjour runtime is shipped with packaged startup surfaces even though the bundled plugin also declares it",
        sampleFiles: ["extensions/bonjour/src/advertiser.ts"],
        sections: ["extensions"],
        spec: "^1.3.7",
      },
      {
        category: "root_owned_extension_runtime",
        declaredInExtensions: ["browser:dependencies"],
        depName: "playwright-core",
        fileCount: 1,
        internalizedBundledRuntimeOwners: [],
        recommendation:
          "keep at root; the internal browser runtime is shipped with core even though downloadable browser-adjacent plugins also declare it",
        sampleFiles: ["extensions/browser/src/browser/playwright-core.runtime.ts"],
        sections: ["extensions"],
        spec: "1.59.1",
      },
    ]);
    expect(collectRootDependencyOwnershipCheckErrors(records)).toStrictEqual([]);
  });

  it("allows runtime deps for bundled plugins that are still packaged in core", () => {
    const repoRoot = makeTempRepo();
    writeRepoFile(
      repoRoot,
      "package.json",
      JSON.stringify({
        dependencies: { "vendor-sdk": "^1.0.0" },
        files: ["dist/", "!dist/extensions/externalized/**"],
      }),
    );
    writeRepoFile(
      repoRoot,
      "extensions/internal/package.json",
      JSON.stringify({ dependencies: { "vendor-sdk": "^1.0.0" } }),
    );
    writeRepoFile(repoRoot, "extensions/internal/openclaw.plugin.json", JSON.stringify({}));
    writeRepoFile(
      repoRoot,
      "extensions/internal/src/setup.ts",
      'const sdk = await import("vendor-sdk");\n',
    );

    const records = collectRootDependencyOwnershipAudit({ repoRoot, scanRoots: ["extensions"] });

    expect(records).toEqual([
      {
        category: "root_owned_extension_runtime",
        declaredInExtensions: ["internal:dependencies"],
        depName: "vendor-sdk",
        fileCount: 1,
        internalizedBundledRuntimeOwners: ["internal:dependencies"],
        recommendation:
          "keep at root while bundled plugin runtime dependencies are internalized; owners: internal:dependencies",
        sampleFiles: ["extensions/internal/src/setup.ts"],
        sections: ["extensions"],
        spec: "^1.0.0",
      },
    ]);
    expect(collectRootDependencyOwnershipCheckErrors(records)).toStrictEqual([]);
  });

  it("keeps excluded bundled plugin deps localizable", () => {
    const repoRoot = makeTempRepo();
    writeRepoFile(
      repoRoot,
      "package.json",
      JSON.stringify({
        dependencies: { "vendor-sdk": "^1.0.0" },
        files: ["dist/", "!dist/extensions/externalized/**"],
      }),
    );
    writeRepoFile(
      repoRoot,
      "extensions/externalized/package.json",
      JSON.stringify({ dependencies: { "vendor-sdk": "^1.0.0" } }),
    );
    writeRepoFile(repoRoot, "extensions/externalized/openclaw.plugin.json", JSON.stringify({}));
    writeRepoFile(
      repoRoot,
      "extensions/externalized/src/setup.ts",
      'const sdk = await import("vendor-sdk");\n',
    );

    const records = collectRootDependencyOwnershipAudit({ repoRoot, scanRoots: ["extensions"] });

    expect(records).toEqual([
      {
        category: "extension_only_localizable",
        declaredInExtensions: ["externalized:dependencies"],
        depName: "vendor-sdk",
        fileCount: 1,
        internalizedBundledRuntimeOwners: [],
        recommendation:
          "remove from root package.json and rely on owning extension manifests plus doctor --fix",
        sampleFiles: ["extensions/externalized/src/setup.ts"],
        sections: ["extensions"],
        spec: "^1.0.0",
      },
    ]);
  });
});
