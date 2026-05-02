import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import {
  buildPublishedInstallCommandArgs,
  buildPublishedInstallScenarios,
  collectInstalledContextEngineRuntimeErrors,
  collectInstalledRootDependencyManifestErrors,
  collectInstalledPackageErrors,
  normalizeInstalledBinaryVersion,
  resolveInstalledBinaryPath,
} from "../scripts/openclaw-npm-postpublish-verify.ts";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../src/plugins/runtime-sidecar-paths.ts";

const PUBLISHED_BUNDLED_RUNTIME_SIDECAR_PATHS = BUNDLED_RUNTIME_SIDECAR_PATHS.filter(
  (relativePath) => listBundledPluginPackArtifacts().includes(relativePath),
);
const REQUIRED_INSTALLED_RUNTIME_SIDECAR_PATHS = [
  ...PUBLISHED_BUNDLED_RUNTIME_SIDECAR_PATHS,
] as const;

describe("buildPublishedInstallScenarios", () => {
  it("uses a single fresh scenario for plain stable releases", () => {
    expect(buildPublishedInstallScenarios("2026.3.23")).toEqual([
      {
        name: "fresh-exact",
        installSpecs: ["openclaw@2026.3.23"],
        expectedVersion: "2026.3.23",
      },
    ]);
  });

  it("adds a stable-to-correction upgrade scenario for correction releases", () => {
    expect(buildPublishedInstallScenarios("2026.3.23-2")).toEqual([
      {
        name: "fresh-exact",
        installSpecs: ["openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
      {
        name: "upgrade-from-base-stable",
        installSpecs: ["openclaw@2026.3.23", "openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
    ]);
  });
});

describe("buildPublishedInstallCommandArgs", () => {
  it("runs lifecycle scripts for published install verification", () => {
    const args = buildPublishedInstallCommandArgs("/tmp/openclaw-prefix", "openclaw@2026.4.10");

    expect(args).toEqual([
      "install",
      "-g",
      "--prefix",
      "/tmp/openclaw-prefix",
      "openclaw@2026.4.10",
      "--no-fund",
      "--no-audit",
    ]);
    expect(args).not.toContain("--ignore-scripts");
  });
});

describe("collectInstalledPackageErrors", () => {
  it("flags version mismatches and missing runtime sidecars", () => {
    const errors = collectInstalledPackageErrors({
      expectedVersion: "2026.3.23-2",
      installedVersion: "2026.3.23",
      packageRoot: "/tmp/empty-openclaw",
    });

    expect(errors[0]).toBe(
      "installed package version mismatch: expected 2026.3.23-2, found 2026.3.23.",
    );
    expect(errors).toEqual(
      expect.arrayContaining(
        REQUIRED_INSTALLED_RUNTIME_SIDECAR_PATHS.map(
          (relativePath) =>
            `installed package is missing required bundled runtime sidecar: ${relativePath}`,
        ),
      ),
    );
    expect(errors.length).toBeGreaterThanOrEqual(
      1 + REQUIRED_INSTALLED_RUNTIME_SIDECAR_PATHS.length,
    );
  });
});

describe("collectInstalledContextEngineRuntimeErrors", () => {
  function makeInstalledPackageRoot(): string {
    return mkdtempSync(join(tmpdir(), "openclaw-postpublish-context-engine-"));
  }

  it("rejects packaged bundles with unresolved legacy context engine runtime loaders", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "runtime-plugins-BUG.js"),
        'throw new Error("Failed to load legacy context engine runtime.");\n',
        "utf8",
      );

      expect(collectInstalledContextEngineRuntimeErrors(packageRoot)).toEqual([
        "installed package includes unresolved legacy context engine runtime loader; rebuild with a bundler-traceable LegacyContextEngine import.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts packaged bundles that inline the legacy context engine registration", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "runtime-plugins-OK.js"),
        "registerContextEngineForOwner('legacy', async () => new LegacyContextEngine());\n",
        "utf8",
      );

      expect(collectInstalledContextEngineRuntimeErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});

describe("normalizeInstalledBinaryVersion", () => {
  it("accepts decorated CLI version output", () => {
    expect(normalizeInstalledBinaryVersion("OpenClaw 2026.4.8 (9ece252)")).toBe("2026.4.8");
    expect(normalizeInstalledBinaryVersion("OpenClaw 2026.4.8-beta.1 (9ece252)")).toBe(
      "2026.4.8-beta.1",
    );
  });
});

describe("resolveInstalledBinaryPath", () => {
  it("uses the Unix global bin path on non-Windows platforms", () => {
    expect(resolveInstalledBinaryPath("/tmp/openclaw-prefix", "darwin")).toBe(
      "/tmp/openclaw-prefix/bin/openclaw",
    );
  });

  it("uses the Windows npm shim path on win32", () => {
    expect(resolveInstalledBinaryPath("C:/openclaw-prefix", "win32")).toBe(
      "C:/openclaw-prefix/openclaw.cmd",
    );
  });
});

describe("collectInstalledRootDependencyManifestErrors", () => {
  function makeInstalledPackageRoot(): string {
    return mkdtempSync(join(tmpdir(), "openclaw-postpublish-root-deps-"));
  }

  function writePackageFile(root: string, relativePath: string, value: unknown): void {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  it("flags root dist imports whose declared runtime package name is missing", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "typebox-CXXonh2u.js"),
        'import { Type } from "typebox";\nexport { Type };\n',
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package root is missing declared runtime dependency 'typebox' for dist importers: typebox-CXXonh2u.js. Add it to package.json dependencies/optionalDependencies.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts root dist imports when the runtime package name is declared", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {
          typebox: "1.1.28",
        },
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "typebox-CXXonh2u.js"),
        'import { Type } from "typebox";\nexport { Type };\n',
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("flags undeclared imports from mjs and cjs root dist files", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "esm-entry.mjs"),
        'export { value } from "mjs-only";\n',
        "utf8",
      );
      writeFileSync(
        join(packageRoot, "dist", "cjs-entry.cjs"),
        'const cjsOnly = require("cjs-only");\nmodule.exports = cjsOnly;\n',
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package root is missing declared runtime dependency 'cjs-only' for dist importers: cjs-entry.cjs. Add it to package.json dependencies/optionalDependencies.",
        "installed package root is missing declared runtime dependency 'mjs-only' for dist importers: esm-entry.mjs. Add it to package.json dependencies/optionalDependencies.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("ignores import-like text inside comments", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "comment-only.js"),
        [
          '// import "fake-package";',
          '/* require("fake-package-two"); */',
          "export const ok = true;",
          "",
        ].join("\n"),
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("ignores import-like text inside string literals", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "string-only.js"),
        [
          "export const help = \"run import('fake-package') after setup\";",
          'export const note = "from \\"fake-package-two\\"";',
          "",
        ].join("\n"),
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("returns a structured error when installed package.json is invalid", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), "{not-json\n", "utf8");

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
        expect.stringMatching(/^installed package\.json could not be parsed:/u),
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("refuses oversized root dist files", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.22",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "oversized.js"),
        "x".repeat(2 * 1024 * 1024 + 1),
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package root dist file 'oversized.js' is invalid or exceeds 2097152 bytes.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
