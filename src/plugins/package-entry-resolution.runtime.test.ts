import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PackageManifest } from "./manifest.js";
import {
  resolvePackageRuntimeExtensionSources,
  resolvePackageSetupSource,
  validatePackageExtensionEntriesForInstall,
} from "./package-entry-resolution.js";
import {
  clearPluginRuntimeArtifactResolutionMemo,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";

const packageRoots: string[] = [];

function createPackageFixture(params: {
  sourceExtension: string;
  runtimeOutputs?: string[];
  includeSource?: boolean;
}): { packageDir: string; sourceEntry: string; manifest: PackageManifest } {
  const packageDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-runtime-entry-")),
  );
  packageRoots.push(packageDir);
  const sourceEntry = `./src/entry${params.sourceExtension}`;
  if (params.includeSource !== false) {
    fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, sourceEntry), "export default {};\n");
  }
  for (const relativeOutput of params.runtimeOutputs ?? []) {
    const outputPath = path.join(packageDir, relativeOutput);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "export default {};\n");
  }
  return {
    packageDir,
    sourceEntry,
    manifest: {
      name: "runtime-entry-fixture",
      version: "1.0.0",
      openclaw: { extensions: [sourceEntry], setupEntry: sourceEntry },
    },
  };
}

afterEach(() => {
  clearPluginRuntimeArtifactResolutionMemo();
  for (const packageRoot of packageRoots.splice(0)) {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

describe("canonical installed package runtime entries", () => {
  it.each([
    {
      name: "TSX source with its flat JavaScript build",
      sourceExtension: ".tsx",
      runtimeOutputs: ["dist/entry.js"],
      expectedRuntime: "dist/entry.js",
    },
    {
      name: "TSX source omitted from a published package",
      sourceExtension: ".tsx",
      runtimeOutputs: ["dist/entry.js"],
      includeSource: false,
      expectedRuntime: "dist/entry.js",
    },
    {
      name: "TypeScript compiler output that preserves the src directory",
      sourceExtension: ".ts",
      runtimeOutputs: ["dist/src/entry.js"],
      expectedRuntime: "dist/src/entry.js",
    },
    {
      name: "ES module TypeScript output ahead of an unrelated .js artifact",
      sourceExtension: ".mts",
      runtimeOutputs: ["dist/entry.js", "dist/entry.mjs"],
      expectedRuntime: "dist/entry.mjs",
    },
    {
      name: "CommonJS TypeScript output ahead of an unrelated .js artifact",
      sourceExtension: ".cts",
      runtimeOutputs: ["dist/entry.js", "dist/entry.cjs"],
      expectedRuntime: "dist/entry.cjs",
    },
  ])("keeps install, discovery, setup, and loading aligned for $name", async (scenario) => {
    const { packageDir, sourceEntry, manifest } = createPackageFixture(scenario);
    const installResult = await validatePackageExtensionEntriesForInstall({
      packageDir,
      extensions: [sourceEntry],
      manifest,
    });
    const diagnostics: Parameters<typeof resolvePackageRuntimeExtensionSources>[0]["diagnostics"] =
      [];
    const runtimeSources = resolvePackageRuntimeExtensionSources({
      packageDir,
      manifest,
      extensions: [sourceEntry],
      origin: "global",
      sourceLabel: packageDir,
      diagnostics,
    });
    const setupSource = resolvePackageSetupSource({
      packageDir,
      manifest,
      origin: "global",
      sourceLabel: packageDir,
      diagnostics,
    });
    const artifact = resolvePluginRuntimeArtifact({
      pluginId: "runtime-entry-fixture",
      entryKind: "runtime",
      source: path.join(packageDir, sourceEntry),
      rootDir: packageDir,
      origin: "global",
      preferBuiltPluginArtifacts: true,
    });
    const expectedSource = fs.realpathSync(path.join(packageDir, scenario.expectedRuntime));

    expect(installResult).toEqual({ ok: true });
    expect(runtimeSources).toEqual([expectedSource]);
    expect(setupSource).toBe(expectedSource);
    expect(artifact.source).toBe(expectedSource);
    expect(diagnostics).toEqual([]);
  });

  it.each([".ts", ".tsx", ".mts", ".cts"])(
    "rejects published source-only %s entries while allowing linked source checkouts",
    async (sourceExtension) => {
      const { packageDir, sourceEntry, manifest } = createPackageFixture({ sourceExtension });
      const installResult = await validatePackageExtensionEntriesForInstall({
        packageDir,
        extensions: [sourceEntry],
        manifest,
      });
      const linkedInstallResult = await validatePackageExtensionEntriesForInstall({
        packageDir,
        extensions: [sourceEntry],
        manifest,
        allowSourceTypeScriptEntries: true,
      });
      const diagnostics: Parameters<
        typeof resolvePackageRuntimeExtensionSources
      >[0]["diagnostics"] = [];

      expect(installResult).toEqual({
        ok: false,
        error: expect.stringContaining("requires compiled runtime output"),
      });
      expect(linkedInstallResult).toEqual({ ok: true });
      expect(
        resolvePackageRuntimeExtensionSources({
          packageDir,
          manifest,
          extensions: [sourceEntry],
          origin: "global",
          sourceLabel: packageDir,
          diagnostics,
        }),
      ).toEqual([]);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("requires compiled runtime output"),
        }),
      ]);
      expect(
        resolvePackageRuntimeExtensionSources({
          packageDir,
          manifest,
          extensions: [sourceEntry],
          origin: "global",
          requireBuiltRuntimeEntry: false,
          sourceLabel: packageDir,
          diagnostics: [],
        }),
      ).toEqual([fs.realpathSync(path.join(packageDir, sourceEntry))]);
    },
  );
});
