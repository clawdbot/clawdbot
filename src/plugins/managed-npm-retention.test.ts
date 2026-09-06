import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "./managed-npm-retention-contract.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
} from "./managed-npm-retention.js";

const retentionTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("managed npm retention", () => {
  it.each(["ordinary", "generation"] as const)(
    "cleans a retired %s project while preserving the active install root",
    async (layout) => {
      const stateDir = retentionTempDirs.make("openclaw-retention-");
      const npmDir = path.join(stateDir, "npm");
      const packageName = "@openclaw/codex";
      const oldProjectRoot =
        layout === "ordinary"
          ? resolvePluginNpmProjectDir({ npmDir, packageName })
          : resolvePluginNpmGenerationProjectDir({
              npmDir,
              packageName,
              generationKey: "codex-v1",
            });
      const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
        npmDir,
        packageName,
        generationKey: "codex-v2",
      });
      const oldPackageDir = path.join(oldProjectRoot, "node_modules", "@openclaw", "codex");
      const activePackageDir = path.join(activeProjectRoot, "node_modules", "@openclaw", "codex");
      fs.mkdirSync(oldPackageDir, { recursive: true });
      fs.mkdirSync(activePackageDir, { recursive: true });
      await markRetainedManagedNpmInstall({
        packageDir: oldPackageDir,
        pluginId: "codex",
        reason: "test-retired-generation",
      });

      await expect(
        cleanupRetainedManagedNpmInstallGenerations({
          npmDir,
          activeInstallPaths: [activePackageDir],
        }),
      ).resolves.toBe(1);
      expect(fs.existsSync(oldProjectRoot)).toBe(false);
      expect(fs.existsSync(activeProjectRoot)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(activePackageDir)).toBe(false);
    },
  );

  it("cleans retained packages from the legacy shared npm root", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-");
    const npmDir = path.join(stateDir, "npm");
    const packageDir = path.join(npmDir, "node_modules", "@openclaw", "codex");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: "test-legacy-generation",
    });

    await expect(
      cleanupRetainedManagedNpmInstallGenerations({
        npmDir,
      }),
    ).resolves.toBe(1);
    expect(fs.existsSync(packageDir)).toBe(false);
    expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(false);
  });

  it("preserves a noncanonical project root even when it has a retained marker", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-noncanonical-");
    const npmDir = path.join(stateDir, "npm");
    const projectRoot = path.join(npmDir, "projects", "noncanonical-sibling");
    const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    const siblingFile = path.join(projectRoot, "must-remain.txt");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(siblingFile, "preserve me", "utf8");
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: "test-retired-generation",
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
    expect(fs.readFileSync(siblingFile, "utf8")).toBe("preserve me");
  });

  it("does not follow a substituted managed projects directory", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-symlink-");
    const npmDir = path.join(stateDir, "npm");
    const outsideProjectsDir = retentionTempDirs.make("openclaw-retention-outside-");
    fs.mkdirSync(npmDir, { recursive: true });
    fs.symlinkSync(outsideProjectsDir, path.join(npmDir, "projects"), "dir");
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir,
      packageName: "@openclaw/codex",
    });
    const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    const sentinel = path.join(projectRoot, "must-remain.txt");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(sentinel, "preserve me", "utf8");
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: "test-retired-generation",
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve me");
  });

  it.each(["project", "legacy"] as const)(
    "preserves %s packages retained by an explicit keep-files uninstall",
    async (layout) => {
      const stateDir = retentionTempDirs.make("openclaw-retention-");
      const npmDir = path.join(stateDir, "npm");
      const projectRoot =
        layout === "legacy"
          ? npmDir
          : resolvePluginNpmGenerationProjectDir({
              npmDir,
              packageName: "@openclaw/kept-plugin",
              generationKey: "kept-plugin-v1",
            });
      const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "kept-plugin");
      fs.mkdirSync(packageDir, { recursive: true });
      await markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "kept-plugin",
        reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
      });

      await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
      expect(fs.existsSync(packageDir)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
    },
  );
});
