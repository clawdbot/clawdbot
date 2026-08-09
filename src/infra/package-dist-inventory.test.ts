// Covers package dist inventory collection and validation.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  isLegacyPluginDependencyInstallStagePath,
  LOCAL_BUILD_METADATA_DIST_PATHS,
  PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  writePackageDistInventory,
  writePackageDistInventoryForPublish,
} from "../../scripts/lib/package-dist-inventory.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  collectPackageDistInventory,
  readPackageDistInventoryIfPresent,
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
      await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toStrictEqual([
        "dist/current-BR6xv1a1.js",
      ]);

      await fs.rm(currentFile);
      await fs.writeFile(
        path.join(packageRoot, "dist", "stale-CJUAgRQR.js"),
        "export {};\n",
        "utf8",
      );

      await expect(collectPackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/stale-CJUAgRQR.js",
      ]);
    });
  });

  it("keeps the pending install guard outside the expected inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-install-guard-" }, async (packageRoot) => {
      const currentFile = path.join(packageRoot, "dist", "current.js");
      await fs.mkdir(path.dirname(currentFile), { recursive: true });
      await fs.writeFile(currentFile, "export {};\n", "utf8");

      await expect(writePackageDistInventoryForPublish(packageRoot)).resolves.toEqual([
        "dist/current.js",
      ]);
      await expect(collectPackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/current.js",
        PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
      ]);
      await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toEqual([
        "dist/current.js",
      ]);
      await expect(
        fs.readFile(path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH), "utf8"),
      ).resolves.toContain("preinstall has not completed");
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
      const omittedDeepPluginSdkDeclaration = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "src",
        "plugin-sdk",
        "provider-entry.d.ts",
      );
      const flatPluginSdkDeclaration = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "provider-entry.d.ts",
      );
      const omittedQaRuntimeChunk = path.join(packageRoot, "dist", "qa-runtime-B9LDtssJ.js");
      const [omittedBuildStamp, omittedRuntimePostBuildStamp] = LOCAL_BUILD_METADATA_DIST_PATHS.map(
        (relativePath) => path.join(packageRoot, relativePath),
      );
      const omittedMap = path.join(packageRoot, "dist", "feature.runtime.js.map");
      await fs.mkdir(path.dirname(packagedQaChannelRuntime), { recursive: true });
      await fs.mkdir(path.dirname(packagedQaLabRuntime), { recursive: true });
      await fs.mkdir(path.dirname(omittedQaLabTypes), { recursive: true });
      await fs.mkdir(path.join(packageRoot, "dist", "plugin-sdk"), { recursive: true });
      await fs.mkdir(path.dirname(omittedDeepPluginSdkDeclaration), { recursive: true });
      await fs.writeFile(packagedQaChannelRuntime, "export {};\n", "utf8");
      await fs.writeFile(packagedQaLabRuntime, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaLabChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaLabPluginSdk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChannelPluginSdk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChannelProtocolPluginSdk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaLabTypes, "export {};\n", "utf8");
      await fs.writeFile(omittedDeepPluginSdkDeclaration, "export {};\n", "utf8");
      await fs.writeFile(flatPluginSdkDeclaration, "export {};\n", "utf8");
      await fs.writeFile(omittedQaRuntimeChunk, "export {};\n", "utf8");
      await fs.writeFile(
        expectDefined(omittedBuildStamp, "omittedBuildStamp test invariant"),
        "{}\n",
        "utf8",
      );
      await fs.writeFile(
        expectDefined(omittedRuntimePostBuildStamp, "omittedRuntimePostBuildStamp test invariant"),
        "{}\n",
        "utf8",
      );
      await fs.writeFile(omittedMap, "{}", "utf8");

      await expect(writePackageDistInventory(packageRoot)).resolves.toStrictEqual([
        "dist/plugin-sdk/provider-entry.d.ts",
      ]);
    });
  });

  it("honors package files exclusions when writing the dist inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-package-files-" }, async (packageRoot) => {
      const packagedRuntime = path.join(packageRoot, "dist", "plugin-sdk", "runtime.js");
      const omittedTestRuntime = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "plugin-test-runtime.js",
      );
      const omittedTestTypes = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "plugin-test-runtime.d.ts",
      );
      const omittedNestedHelper = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "src",
        "test-utils",
        "helpers.d.ts",
      );
      const omittedQaCompat = path.join(packageRoot, "dist", "plugin-sdk", "qa-channel.js");
      const omittedRuntimeChunk = path.join(packageRoot, "dist", "qa-runtime-AbC123.js");
      const omittedTopLevelMap = path.join(packageRoot, "dist", "runtime.js.map");
      const omittedMap = path.join(packageRoot, "dist", "plugin-sdk", "runtime.js.map");
      const omittedAppBundle = path.join(packageRoot, "dist", "OpenClaw.app");

      await fs.mkdir(path.dirname(packagedRuntime), { recursive: true });
      await fs.mkdir(path.dirname(omittedNestedHelper), { recursive: true });
      await fs.mkdir(omittedAppBundle, { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          files: [
            "dist/",
            "!dist/OpenClaw.app/**",
            "!dist/plugin-sdk/plugin-test-runtime.js",
            "!dist/plugin-sdk/plugin-test-runtime.d.ts",
            "!dist/plugin-sdk/src/test-utils/**",
            "!dist/plugin-sdk/qa-channel.*",
            "!dist/qa-runtime-*.js",
            "!dist/**/*.map",
          ],
        }),
        "utf8",
      );
      await fs.writeFile(packagedRuntime, "export {};\n", "utf8");
      await fs.writeFile(omittedTestRuntime, "export {};\n", "utf8");
      await fs.writeFile(omittedTestTypes, "export {};\n", "utf8");
      await fs.writeFile(omittedNestedHelper, "export {};\n", "utf8");
      await fs.writeFile(omittedQaCompat, "export {};\n", "utf8");
      await fs.writeFile(omittedRuntimeChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedTopLevelMap, "{}", "utf8");
      await fs.writeFile(omittedMap, "{}", "utf8");
      await fs.symlink(packageRoot, path.join(omittedAppBundle, "Autoupdate"));

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/plugin-sdk/runtime.js",
      ]);
    });
  });

  it("keeps transient plugin dependency trees out of the inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-plugin-deps-" }, async (packageRoot) => {
      const realFile = path.join(packageRoot, "dist", "index.js");
      const rootDependencyPackage = path.join(
        packageRoot,
        "dist",
        "extensions",
        "node_modules",
        "openclaw",
        "package.json",
      );
      const pluginDependencyPackage = path.join(
        packageRoot,
        "dist",
        "extensions",
        "slack",
        "node_modules",
        "left-pad",
        "package.json",
      );
      await fs.mkdir(path.dirname(realFile), { recursive: true });
      await fs.mkdir(path.dirname(rootDependencyPackage), { recursive: true });
      await fs.mkdir(path.dirname(pluginDependencyPackage), { recursive: true });
      await fs.writeFile(realFile, "export {};\n", "utf8");
      await fs.writeFile(rootDependencyPackage, "{}", "utf8");
      await fs.writeFile(pluginDependencyPackage, "{}", "utf8");

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual(["dist/index.js"]);
    });
  });

  it("omits packaged extension node_modules while keeping extension runtime files", async () => {
    await withTempDir(
      { prefix: "openclaw-dist-inventory-extension-node-modules-" },
      async (packageRoot) => {
        const extensionRuntime = path.join(
          packageRoot,
          "dist",
          "extensions",
          "demo",
          "runtime-api.js",
        );
        const rootSdkAliasPackage = path.join(
          packageRoot,
          "dist",
          "extensions",
          "node_modules",
          "openclaw",
          "package.json",
        );
        const extensionDependencyPackage = path.join(
          packageRoot,
          "dist",
          "extensions",
          "demo",
          "node_modules",
          "left-pad",
          "package.json",
        );

        await fs.mkdir(path.dirname(extensionRuntime), { recursive: true });
        await fs.mkdir(path.dirname(rootSdkAliasPackage), { recursive: true });
        await fs.mkdir(path.dirname(extensionDependencyPackage), { recursive: true });
        await fs.writeFile(extensionRuntime, "export {};\n", "utf8");
        await fs.writeFile(rootSdkAliasPackage, "{}", "utf8");
        await fs.writeFile(extensionDependencyPackage, "{}", "utf8");

        await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
          "dist/extensions/demo/runtime-api.js",
        ]);
      },
    );
  });

  it("keeps publishable externalized bundled plugin dist trees out of the inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-externalized-" }, async (packageRoot) => {
      const externalizedRuntime = path.join(
        packageRoot,
        "dist",
        "extensions",
        "external-chat",
        "index.js",
      );
      const bundledRuntime = path.join(
        packageRoot,
        "dist",
        "extensions",
        "bundled-chat",
        "index.js",
      );
      const externalizedPackageJson = path.join(
        packageRoot,
        "extensions",
        "external-chat",
        "package.json",
      );
      const bundledPackageJson = path.join(
        packageRoot,
        "extensions",
        "bundled-chat",
        "package.json",
      );
      const rootPackageJson = path.join(packageRoot, "package.json");

      await fs.mkdir(path.dirname(externalizedRuntime), { recursive: true });
      await fs.mkdir(path.dirname(bundledRuntime), { recursive: true });
      await fs.mkdir(path.dirname(externalizedPackageJson), { recursive: true });
      await fs.mkdir(path.dirname(bundledPackageJson), { recursive: true });
      await fs.writeFile(externalizedRuntime, "export {};\n", "utf8");
      await fs.writeFile(bundledRuntime, "export {};\n", "utf8");
      await fs.writeFile(
        rootPackageJson,
        JSON.stringify({
          files: ["dist/", "!dist/extensions/external-chat/**"],
        }),
        "utf8",
      );
      await fs.writeFile(
        externalizedPackageJson,
        JSON.stringify({
          name: "@openclaw/external-chat",
          openclaw: {
            release: {
              publishToClawHub: true,
              publishToNpm: true,
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        bundledPackageJson,
        JSON.stringify({
          name: "@openclaw/bundled-chat",
          openclaw: {},
        }),
        "utf8",
      );

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/extensions/bundled-chat/index.js",
      ]);
    });
  });

  it("keeps publishable core-package runtime plugin dist trees in the inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-core-runtime-" }, async (packageRoot) => {
      const coreRuntime = path.join(packageRoot, "dist", "extensions", "core-chat", "index.js");
      const corePackageJson = path.join(packageRoot, "extensions", "core-chat", "package.json");

      await fs.mkdir(path.dirname(coreRuntime), { recursive: true });
      await fs.mkdir(path.dirname(corePackageJson), { recursive: true });
      await fs.writeFile(coreRuntime, "export {};\n", "utf8");
      await fs.writeFile(
        corePackageJson,
        JSON.stringify({
          name: "@openclaw/core-chat",
          openclaw: {
            release: {
              publishToClawHub: true,
              publishToNpm: true,
            },
          },
        }),
        "utf8",
      );

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/extensions/core-chat/index.js",
      ]);
    });
  });

  it("matches install-stage paths case-insensitively across path segments", () => {
    expect(
      isLegacyPluginDependencyInstallStagePath(
        "dist/extensions/brave/.openclaw-install-stage/node_modules/typebox/package.json",
      ),
    ).toBe(true);
    expect(
      isLegacyPluginDependencyInstallStagePath(
        "dist/Extensions/browser/.OPENCLAW-INSTALL-STAGE-AbC123/node_modules/playwright-core/package.json",
      ),
    ).toBe(true);
    expect(
      isLegacyPluginDependencyInstallStagePath(
        "Dist/Extensions/browser/.OpenClaw-Install-Stage/package.json",
      ),
    ).toBe(true);
    expect(
      isLegacyPluginDependencyInstallStagePath(
        "dist/extensions/browser/.openclaw-runtime-deps-copy-AbC123/package.json",
      ),
    ).toBe(false);
    expect(
      isLegacyPluginDependencyInstallStagePath("dist/extensions/.openclaw-install-stage"),
    ).toBe(false);
  });

  it("rejects pre-populated install-stage debris before writing an inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-stage-" }, async (packageRoot) => {
      for (const relativePath of [
        "dist/extensions/brave/.openclaw-install-stage/package.json",
        "dist/extensions/browser/.openclaw-install-stage-AbC123/node_modules/playwright-core/package.json",
      ]) {
        const filePath = path.join(packageRoot, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, "{}", "utf8");
      }

      await expect(writePackageDistInventory(packageRoot)).rejects.toThrow(
        /unexpected legacy plugin dependency staging debris/u,
      );
    });
  });

  it("rejects mixed-case install-stage debris on case-sensitive builders", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-stage-case-" }, async (packageRoot) => {
      const stagedFile = path.join(
        packageRoot,
        "Dist",
        "Extensions",
        "browser",
        ".OPENCLAW-INSTALL-STAGE-AbC123",
        "package.json",
      );
      await fs.mkdir(path.dirname(stagedFile), { recursive: true });
      await fs.writeFile(stagedFile, "{}", "utf8");

      await expect(writePackageDistInventory(packageRoot)).rejects.toThrow(
        /unexpected legacy plugin dependency staging debris/u,
      );
    });
  });

  it("returns null when the inventory is missing", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-missing-" }, async (packageRoot) => {
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toBeNull();
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
