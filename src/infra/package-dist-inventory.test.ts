import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  assertNoBundledRuntimeDepsStagingDebris,
  collectBundledRuntimeDepsStagingDebrisPaths,
  collectPackageDistInventoryErrors,
  LOCAL_BUILD_METADATA_DIST_PATHS,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  collectPackageDistInventory,
  isBundledRuntimeDepsInstallStagePath,
  writePackageDistInventory,
} from "./package-dist-inventory.js";

describe("package dist inventory", () => {
  it("tracks missing and stale dist files", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-" }, async (packageRoot) => {
      const currentFile = path.join(packageRoot, "dist", "current-BR6xv1a1.js");
      await fs.mkdir(path.dirname(currentFile), { recursive: true });
      await fs.writeFile(currentFile, "export {};\n", "utf8");

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/current-BR6xv1a1.js",
      ]);
      await expect(collectPackageDistInventoryErrors(packageRoot)).resolves.toEqual([]);

      await fs.rm(currentFile);
      await fs.writeFile(
        path.join(packageRoot, "dist", "stale-CJUAgRQR.js"),
        "export {};\n",
        "utf8",
      );

      await expect(collectPackageDistInventoryErrors(packageRoot)).resolves.toEqual([
        "missing packaged dist file dist/current-BR6xv1a1.js",
        "unexpected packaged dist file dist/stale-CJUAgRQR.js",
      ]);
    });
  });

  it("keeps npm-omitted dist artifacts out of the inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-pack-" }, async (packageRoot) => {
      const packagedQaChannelRuntime = path.join(
        packageRoot,
        "dist",
        "extensions",
        "qa-channel",
        "runtime-api.js",
      );
      const packagedQaLabRuntime = path.join(
        packageRoot,
        "dist",
        "extensions",
        "qa-lab",
        "runtime-api.js",
      );
      const omittedQaChunk = path.join(packageRoot, "dist", "extensions", "qa-channel", "cli.js");
      const omittedQaLabChunk = path.join(packageRoot, "dist", "extensions", "qa-lab", "cli.js");
      const omittedQaMatrixChunk = path.join(
        packageRoot,
        "dist",
        "extensions",
        "qa-matrix",
        "index.js",
      );
      const omittedQaLabPluginSdk = path.join(packageRoot, "dist", "plugin-sdk", "qa-lab.js");
      const omittedQaChannelPluginSdk = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "qa-channel.js",
      );
      const omittedQaChannelProtocolPluginSdk = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "qa-channel-protocol.js",
      );
      const omittedQaLabTypes = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "extensions",
        "qa-lab",
        "cli.d.ts",
      );
      const omittedQaRuntimeChunk = path.join(packageRoot, "dist", "qa-runtime-B9LDtssJ.js");
      const omittedRuntimeDepsStamp = path.join(
        packageRoot,
        "dist",
        "extensions",
        "discord",
        ".openclaw-runtime-deps-stamp.json",
      );
      const [omittedBuildStamp, omittedRuntimePostBuildStamp] = LOCAL_BUILD_METADATA_DIST_PATHS.map(
        (relativePath) => path.join(packageRoot, relativePath),
      );
      const omittedRuntimeDepsTempFile = path.join(
        packageRoot,
        "dist",
        "extensions",
        "discord",
        ".openclaw-runtime-deps-backup-node_modules-old",
        "left-pad",
        "index.js",
      );
      const omittedRuntimeDepsTempSymlink = path.join(
        packageRoot,
        "dist",
        "extensions",
        "amazon-bedrock",
        ".openclaw-runtime-deps-copy-KZmXaz",
        "node_modules",
        ".bin",
        "fxparser",
      );
      const omittedExtensionNodeModuleSymlink = path.join(
        packageRoot,
        "dist",
        "extensions",
        "discord",
        "node_modules",
        ".bin",
        "color-support",
      );
      const omittedExtensionRootAliasSymlink = path.join(
        packageRoot,
        "dist",
        "extensions",
        "node_modules",
        "openclaw",
        "plugin-sdk",
      );
      const omittedMap = path.join(packageRoot, "dist", "feature.runtime.js.map");
      await fs.mkdir(path.dirname(packagedQaChannelRuntime), { recursive: true });
      await fs.mkdir(path.dirname(packagedQaLabRuntime), { recursive: true });
      await fs.mkdir(path.dirname(omittedQaMatrixChunk), { recursive: true });
      await fs.mkdir(path.dirname(omittedQaLabTypes), { recursive: true });
      await fs.mkdir(path.dirname(omittedRuntimeDepsStamp), { recursive: true });
      await fs.mkdir(path.dirname(omittedRuntimeDepsTempFile), { recursive: true });
      await fs.mkdir(path.dirname(omittedRuntimeDepsTempSymlink), { recursive: true });
      await fs.mkdir(path.dirname(omittedExtensionNodeModuleSymlink), { recursive: true });
      await fs.mkdir(path.dirname(omittedExtensionRootAliasSymlink), { recursive: true });
      await fs.mkdir(path.join(packageRoot, "dist", "plugin-sdk"), { recursive: true });
      await fs.writeFile(path.join(packageRoot, "color-support.js"), "export {};\n", "utf8");
      await fs.writeFile(packagedQaChannelRuntime, "export {};\n", "utf8");
      await fs.writeFile(packagedQaLabRuntime, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaLabChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaMatrixChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaLabPluginSdk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChannelPluginSdk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChannelProtocolPluginSdk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaLabTypes, "export {};\n", "utf8");
      await fs.writeFile(omittedQaRuntimeChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedRuntimeDepsStamp, "{}\n", "utf8");
      await fs.writeFile(omittedBuildStamp, "{}\n", "utf8");
      await fs.writeFile(omittedRuntimePostBuildStamp, "{}\n", "utf8");
      await fs.writeFile(omittedRuntimeDepsTempFile, "module.exports = 1;\n", "utf8");
      await fs.symlink(path.join(packageRoot, "color-support.js"), omittedRuntimeDepsTempSymlink);
      await fs.symlink(
        path.join(packageRoot, "color-support.js"),
        omittedExtensionNodeModuleSymlink,
      );
      await fs.symlink(
        path.join(packageRoot, "dist", "plugin-sdk"),
        omittedExtensionRootAliasSymlink,
      );
      await fs.writeFile(omittedMap, "{}", "utf8");

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([]);
    });
  });

  it("ignores runtime-created install staging dirs during installed dist verification", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-stage-" }, async (packageRoot) => {
      const realFile = path.join(packageRoot, "dist", "real-AbC123.js");
      await fs.mkdir(path.dirname(realFile), { recursive: true });
      await fs.writeFile(realFile, "export {};\n", "utf8");
      await writePackageDistInventory(packageRoot);

      const bareStageFile = path.join(
        packageRoot,
        "dist",
        "extensions",
        "brave",
        ".openclaw-install-stage",
        "node_modules",
        "typebox",
        "build",
        "compile",
        "code.mjs",
      );
      const suffixedStageFile = path.join(
        packageRoot,
        "dist",
        "extensions",
        "browser",
        ".openclaw-install-stage-AbC123",
        "node_modules",
        "playwright-core",
        "package.json",
      );
      await fs.mkdir(path.dirname(bareStageFile), { recursive: true });
      await fs.writeFile(bareStageFile, "// staged\n", "utf8");
      await fs.mkdir(path.dirname(suffixedStageFile), { recursive: true });
      await fs.writeFile(suffixedStageFile, "{}", "utf8");

      await expect(collectPackageDistInventoryErrors(packageRoot)).resolves.toEqual([]);
    });
  });

  it("matches install-stage paths case-insensitively across path segments", () => {
    expect(
      isBundledRuntimeDepsInstallStagePath(
        "dist/extensions/brave/.openclaw-install-stage/node_modules/typebox/package.json",
      ),
    ).toBe(true);
    expect(
      isBundledRuntimeDepsInstallStagePath(
        "dist/Extensions/browser/.OPENCLAW-INSTALL-STAGE-AbC123/node_modules/playwright-core/package.json",
      ),
    ).toBe(true);
    expect(
      isBundledRuntimeDepsInstallStagePath(
        "Dist/Extensions/browser/.OpenClaw-Install-Stage/package.json",
      ),
    ).toBe(true);
    expect(
      isBundledRuntimeDepsInstallStagePath(
        "dist/extensions/browser/.openclaw-runtime-deps-copy-AbC123/package.json",
      ),
    ).toBe(false);
    expect(isBundledRuntimeDepsInstallStagePath("dist/extensions/.openclaw-install-stage")).toBe(
      false,
    );
  });

  it("rejects pre-populated install-stage debris at publish time", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-stage-publish-" }, async (packageRoot) => {
      const seededStagePackageJson = path.join(
        packageRoot,
        "dist",
        "extensions",
        "evil",
        ".openclaw-install-stage",
        "package.json",
      );
      const suffixedSeed = path.join(
        packageRoot,
        "dist",
        "extensions",
        "browser",
        ".openclaw-install-stage-AbC123",
        "node_modules",
        "playwright-core",
        "package.json",
      );
      await fs.mkdir(path.dirname(seededStagePackageJson), { recursive: true });
      await fs.writeFile(seededStagePackageJson, "{}", "utf8");
      await fs.mkdir(path.dirname(suffixedSeed), { recursive: true });
      await fs.writeFile(suffixedSeed, "{}", "utf8");

      await expect(collectBundledRuntimeDepsStagingDebrisPaths(packageRoot)).resolves.toEqual([
        "dist/extensions/browser/.openclaw-install-stage-AbC123",
        "dist/extensions/evil/.openclaw-install-stage",
      ]);
      await expect(assertNoBundledRuntimeDepsStagingDebris(packageRoot)).rejects.toThrow(
        /unexpected bundled-runtime-deps install staging debris/,
      );
      await expect(writePackageDistInventory(packageRoot)).rejects.toThrow(
        /unexpected bundled-runtime-deps install staging debris/,
      );
    });
  });

  it("rejects mixed-case install-stage debris on case-sensitive release builders", async () => {
    await withTempDir(
      { prefix: "openclaw-dist-inventory-stage-extensions-case-" },
      async (packageRoot) => {
        const mixedCaseStage = path.join(
          packageRoot,
          "dist",
          "Extensions",
          "evil",
          ".OpenClaw-Install-Stage",
          "package.json",
        );
        await fs.mkdir(path.dirname(mixedCaseStage), { recursive: true });
        await fs.writeFile(mixedCaseStage, "{}", "utf8");

        await expect(collectBundledRuntimeDepsStagingDebrisPaths(packageRoot)).resolves.toEqual([
          "dist/Extensions/evil/.OpenClaw-Install-Stage",
        ]);
        await expect(writePackageDistInventory(packageRoot)).rejects.toThrow(
          /unexpected bundled-runtime-deps install staging debris/,
        );
      },
    );

    await withTempDir(
      { prefix: "openclaw-dist-inventory-stage-root-case-" },
      async (packageRoot) => {
        const mixedCaseStage = path.join(
          packageRoot,
          "Dist",
          "Extensions",
          "browser",
          ".OPENCLAW-INSTALL-STAGE-AbC123",
          "package.json",
        );
        await fs.mkdir(path.dirname(mixedCaseStage), { recursive: true });
        await fs.writeFile(mixedCaseStage, "{}", "utf8");

        await expect(collectBundledRuntimeDepsStagingDebrisPaths(packageRoot)).resolves.toEqual([
          "Dist/Extensions/browser/.OPENCLAW-INSTALL-STAGE-AbC123",
        ]);
        await expect(writePackageDistInventory(packageRoot)).rejects.toThrow(
          /unexpected bundled-runtime-deps install staging debris/,
        );
      },
    );
  });

  it("treats a missing dist/extensions tree as no staging debris", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-no-extensions-" }, async (packageRoot) => {
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await expect(collectBundledRuntimeDepsStagingDebrisPaths(packageRoot)).resolves.toEqual([]);
      await expect(assertNoBundledRuntimeDepsStagingDebris(packageRoot)).resolves.toBeUndefined();
    });
  });

  it("fails closed when the inventory is missing", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-missing-" }, async (packageRoot) => {
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await expect(collectPackageDistInventoryErrors(packageRoot)).resolves.toEqual([
        `missing package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`,
      ]);
    });
  });

  it("rejects symlinked dist entries", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-symlink-" }, async (packageRoot) => {
      const distDir = path.join(packageRoot, "dist");
      await fs.mkdir(distDir, { recursive: true });
      await fs.writeFile(path.join(packageRoot, "escape.js"), "export {};\n", "utf8");
      await fs.symlink(path.join(packageRoot, "escape.js"), path.join(distDir, "entry.js"));

      await expect(collectPackageDistInventory(packageRoot)).rejects.toThrow(
        "Unsafe package dist path: dist/entry.js",
      );
    });
  });
});
