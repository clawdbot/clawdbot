import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import {
  buildPublishedInstallCommandArgs,
  buildPublishedInstallScenarios,
  collectInstalledContextEngineRuntimeErrors,
  collectInstalledMirroredRootDependencyManifestErrors,
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

describe("collectInstalledMirroredRootDependencyManifestErrors", () => {
  function makeInstalledPackageRoot(): string {
    return mkdtempSync(join(tmpdir(), "openclaw-postpublish-installed-"));
  }

  function writePackageFile(root: string, relativePath: string, value: unknown): void {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  function writeSlackWebApiProbePackage(params: {
    root: string;
    importerSource?: string;
    importerPath?: string;
    rootDependencies?: Record<string, string>;
    rootOptionalDependencies?: Record<string, string>;
  }): void {
    writePackageFile(params.root, "package.json", {
      version: "2026.4.10",
      dependencies: params.rootDependencies,
      optionalDependencies: params.rootOptionalDependencies,
    });
    writePackageFile(params.root, "dist/extensions/slack/package.json", {
      dependencies: {
        "@slack/web-api": "^7.15.0",
      },
    });
    const importerPath = params.importerPath ?? "dist/probe-Cz2PiFtC.js";
    mkdirSync(join(params.root, "dist"), { recursive: true });
    writeFileSync(
      join(params.root, importerPath),
      params.importerSource ?? 'import("@slack/web-api");\n',
      "utf8",
    );
  }

  it("flags bundled plugin deps imported by root dist when root mirrors are missing", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeSlackWebApiProbePackage({ root: packageRoot });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package root is missing mirrored bundled runtime dependency '@slack/web-api' for dist importers: probe-Cz2PiFtC.js. Add it to package.json dependencies/optionalDependencies or keep imports under dist/extensions/slack/.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("allows bundled plugin deps imported from their own extension dist without root mirrors", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeSlackWebApiProbePackage({
        root: packageRoot,
        importerPath: "dist/extensions/slack/client-Cz2PiFtC.js",
      });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("allows bundled plugin deps imported from root chunks sourced from their extension", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeSlackWebApiProbePackage({
        root: packageRoot,
        importerSource: '//#region extensions/slack/client.ts\nimport("@slack/web-api");\n',
      });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("does not require root mirrors for extension-only Matrix crypto deps", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.10",
        dependencies: {},
      });
      writePackageFile(packageRoot, "dist/extensions/matrix/package.json", {
        dependencies: {
          "@matrix-org/matrix-sdk-crypto-nodejs": "^0.4.0",
          "@matrix-org/matrix-sdk-crypto-wasm": "18.1.0",
        },
      });
      writeFileSync(
        join(packageRoot, "dist/extensions/matrix/crypto-node.runtime.js"),
        'require("@matrix-org/matrix-sdk-crypto-nodejs");\n',
        "utf8",
      );

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts mirrored root dependencies declared in package optionalDependencies", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.10",
        optionalDependencies: {
          "@discordjs/opus": "^0.10.0",
        },
      });
      writePackageFile(packageRoot, "dist/extensions/discord/package.json", {
        optionalDependencies: {
          "@discordjs/opus": "^0.10.0",
        },
      });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist", "probe-Cz2PiFtC.js"),
        'require("@discordjs/opus");\n',
        "utf8",
      );

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("does not compare root mirror dependency versions", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writeSlackWebApiProbePackage({
        root: packageRoot,
        rootDependencies: {
          "@slack/web-api": "^7.16.0",
        },
      });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("flags malformed bundled extension manifests instead of silently skipping them", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.10",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist/extensions/slack"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist/extensions/slack/package.json"),
        '{\n  "openclaw": { invalid json\n',
        "utf8",
      );

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([
        expect.stringContaining("installed bundled extension manifest invalid: failed to parse"),
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("flags bundled extension directories that are missing package.json", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.10",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist/extensions/slack"), { recursive: true });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([
        `installed bundled extension manifest missing: ${join(packageRoot, "dist/extensions/slack/package.json")}.`,
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("skips manifest-only sidecar directories without package.json", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.10",
        dependencies: {},
      });
      writePackageFile(packageRoot, "dist/extensions/device-pair/openclaw.plugin.json", {
        id: "device-pair",
      });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts legacy qa channel sidecar directories without package.json", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.10",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist/extensions/qa-channel"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist/extensions/qa-channel/runtime-api.js"),
        "export {};\n",
        "utf8",
      );

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects bundled extension manifests that are not regular files", () => {
    const packageRoot = makeInstalledPackageRoot();
    const outsideManifestRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.10",
        dependencies: {},
      });
      writePackageFile(outsideManifestRoot, "package.json", {
        dependencies: {
          "@slack/web-api": "^7.15.0",
        },
      });
      mkdirSync(join(packageRoot, "dist/extensions/slack"), { recursive: true });
      symlinkSync(
        join(outsideManifestRoot, "package.json"),
        join(packageRoot, "dist/extensions/slack/package.json"),
      );

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([
        expect.stringContaining("installed bundled extension manifest invalid: failed to parse"),
      ]);
      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)[0]).toContain(
        "manifest must be a regular file",
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
      rmSync(outsideManifestRoot, { recursive: true, force: true });
    }
  });
});
