// Covers plugin install path validation and normalization.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installPluginFromPath, PLUGIN_INSTALL_ERROR_CODE } from "./install.js";
import { packToArchive } from "./test-helpers/archive-fixtures.js";
import { createSyncSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";
import { createBundleInstallFixtureFactory } from "./test-helpers/install-fixtures.js";

const suiteTempRootTracker = createSyncSuiteTempRootTracker("openclaw-plugin-install-path");
const setupBundleInstallFixture = createBundleInstallFixtureFactory(
  suiteTempRootTracker.makeTempDir,
);

function setupNativePluginInstallFixture() {
  const caseDir = suiteTempRootTracker.makeTempDir();
  const stateDir = path.join(caseDir, "state");
  const pluginDir = path.join(caseDir, "plugin-src");
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "symlink-plugin",
      version: "1.0.0",
      openclaw: { extensions: ["./dist/index.js"] },
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "symlink-plugin",
      configSchema: { type: "object", properties: {} },
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "export {};\n", "utf-8");
  return { caseDir, pluginDir, extensionsDir: path.join(stateDir, "extensions") };
}

afterAll(() => {
  suiteTempRootTracker.cleanup();
});

describe("installPluginFromPath", () => {
  it.each(["native plugin", "bundle"] as const)(
    "does not publish an archived %s after authority closes during artifact review",
    async (kind) => {
      const { pluginDir, extensionsDir } =
        kind === "native plugin"
          ? setupNativePluginInstallFixture()
          : setupBundleInstallFixture({ bundleFormat: "claude", name: "Guarded Bundle" });
      const pluginId = kind === "native plugin" ? "symlink-plugin" : "guarded-bundle";
      const archivePath = await packToArchive({
        pkgDir: pluginDir,
        outDir: suiteTempRootTracker.makeTempDir(),
        outName: "guarded-plugin.tgz",
      });
      let authorityActive = true;
      const result = await installPluginFromPath({
        path: archivePath,
        extensionsDir,
        onBeforePluginArtifactCommit: async () => {
          authorityActive = false;
        },
        beforePersistentApply: () => {
          if (!authorityActive) {
            throw new Error("plugin installation authority closed");
          }
        },
      });

      expect(authorityActive).toBe(false);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("plugin installation authority closed"),
      });
      expect(fs.existsSync(path.join(extensionsDir, pluginId))).toBe(false);
    },
  );

  it("rejects managed plain file plugin installs through path install", async () => {
    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "console.log('SAFE');\n", "utf-8");

    const result = await installPluginFromPath({
      path: sourcePath,
      extensionsDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN);
    expect(result.error).toBe(
      "Plain file plugin installs are not supported. Install a plugin directory or archive that contains openclaw.plugin.json, or list standalone plugin files in plugins.load.paths.",
    );
  });

  it.runIf(process.platform !== "win32")(
    "installs local plugin directories when the managed extensions root is a symlink",
    async () => {
      const { caseDir, pluginDir, extensionsDir } = setupNativePluginInstallFixture();
      const realExtensionsDir = path.join(caseDir, "data", "extensions");
      fs.mkdirSync(realExtensionsDir, { recursive: true });
      fs.mkdirSync(path.dirname(extensionsDir), { recursive: true });
      fs.symlinkSync(realExtensionsDir, extensionsDir, "dir");

      const result = await installPluginFromPath({
        path: pluginDir,
        extensionsDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.targetDir).toBe(path.join(extensionsDir, "symlink-plugin"));
      expect(fs.existsSync(path.join(realExtensionsDir, "symlink-plugin", "package.json"))).toBe(
        true,
      );
    },
  );

  it.each([
    {
      format: "agent" as const,
      name: "Portable Sample",
      pluginId: "portable-sample",
      archiveName: "agent-bundle.tgz",
      manifestPath: "plugin.json",
    },
    {
      format: "claude" as const,
      name: "Claude Sample",
      pluginId: "claude-sample",
      archiveName: "claude-bundle.tgz",
      manifestPath: path.join(".claude-plugin", "plugin.json"),
    },
  ])(
    "installs $format bundles from an archive path",
    async ({ format, name, pluginId, archiveName, manifestPath }) => {
      const { pluginDir, extensionsDir } = setupBundleInstallFixture({
        bundleFormat: format,
        name,
      });
      const archivePath = path.join(suiteTempRootTracker.makeTempDir(), archiveName);

      await packToArchive({
        pkgDir: pluginDir,
        outDir: path.dirname(archivePath),
        outName: path.basename(archivePath),
      });

      const result = await installPluginFromPath({
        path: archivePath,
        extensionsDir,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.pluginId).toBe(pluginId);
      expect(fs.existsSync(path.join(result.targetDir, manifestPath))).toBe(true);
    },
  );
});
