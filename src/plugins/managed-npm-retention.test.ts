import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import {
  RETAINED_MANAGED_NPM_DOCTOR_REPAIR_REASON,
  RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
  RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
  RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
  RETAINED_MANAGED_NPM_PLUGIN_SOURCE_CHANGE_REASON,
} from "./managed-npm-retention-contract.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
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
        reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
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
      reason: RETAINED_MANAGED_NPM_DOCTOR_REPAIR_REASON,
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
      reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
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
      reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(0);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve me");
  });

  it("ignores unmarked legacy packages without reporting an error", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-");
    const npmDir = path.join(stateDir, "npm");
    const packageDir = path.join(npmDir, "node_modules", "@openclaw", "active-plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    const onError = vi.fn();

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir, onError })).resolves.toBe(0);

    expect(fs.existsSync(packageDir)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
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

  it.each([
    { layout: "project" as const, markerState: "corrupt" as const },
    { layout: "legacy" as const, markerState: "corrupt" as const },
    { layout: "project" as const, markerState: "unknown" as const },
    { layout: "legacy" as const, markerState: "unknown" as const },
  ])(
    "preserves $layout package files for a $markerState marker",
    async ({ layout, markerState }) => {
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
        reason:
          markerState === "unknown"
            ? "future-retention-policy"
            : RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
      });
      if (markerState === "corrupt") {
        fs.writeFileSync(resolveRetainedManagedNpmInstallMarkerPath(packageDir), "{", "utf8");
      }
      const onError = vi.fn();

      await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir, onError })).resolves.toBe(
        0,
      );

      expect(fs.existsSync(packageDir)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        layout === "legacy" ? packageDir : projectRoot,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports inaccessible legacy markers while preserving package files",
    async () => {
      const stateDir = retentionTempDirs.make("openclaw-retention-");
      const npmDir = path.join(stateDir, "npm");
      const packageDir = path.join(npmDir, "node_modules", "@openclaw", "kept-plugin");
      fs.mkdirSync(packageDir, { recursive: true });
      await markRetainedManagedNpmInstall({
        packageDir,
        pluginId: "kept-plugin",
        reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
      });
      const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
      const markerDir = path.dirname(markerPath);
      const onError = vi.fn();
      fs.chmodSync(markerDir, 0o000);

      try {
        expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
        await expect(
          cleanupRetainedManagedNpmInstallGenerations({ npmDir, onError }),
        ).resolves.toBe(0);
      } finally {
        fs.chmodSync(markerDir, 0o700);
      }

      expect(fs.existsSync(packageDir)).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: expect.stringMatching(/^(?:EACCES|EPERM)$/u) }),
        packageDir,
      );
    },
  );

  it("cleans staged Codex inference activation markers", async () => {
    const stateDir = retentionTempDirs.make("openclaw-retention-");
    const npmDir = path.join(stateDir, "npm");
    const projectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName: "@openclaw/codex",
      generationKey: "inference-v1",
    });
    const packageDir = path.join(projectRoot, "node_modules", "@openclaw", "codex");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "codex",
      reason: RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(1);
    expect(fs.existsSync(packageDir)).toBe(false);
  });

  it.each([
    RETAINED_MANAGED_NPM_DOCTOR_REPAIR_REASON,
    RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
    RETAINED_MANAGED_NPM_PLUGIN_SOURCE_CHANGE_REASON,
    RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
  ])("cleans the canonical cleanup-eligible reason %s", async (reason) => {
    const stateDir = retentionTempDirs.make("openclaw-retention-contract-");
    const npmDir = path.join(stateDir, "npm");
    const packageDir = path.join(npmDir, "node_modules", "@openclaw", "retired-plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "retired-plugin",
      reason,
    });

    await expect(cleanupRetainedManagedNpmInstallGenerations({ npmDir })).resolves.toBe(1);
    expect(fs.existsSync(packageDir)).toBe(false);
  });
});
