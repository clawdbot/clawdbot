import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writePersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import {
  RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
  RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
  RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
} from "../plugins/managed-npm-retention-contract.js";
import {
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "../plugins/managed-npm-retention.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupRetainedPluginInstallGenerations } from "./server-retained-plugin-cleanup.js";

it("preserves package files retained by plugin uninstall", async () => {
  await withOpenClawTestState({ label: "gateway-retained-plugin-cleanup" }, async (state) => {
    const packageDir = writeManagedNpmPlugin({
      stateDir: state.stateDir,
      packageName: "@openclaw/kept-plugin",
      pluginId: "kept-plugin",
      version: "1.0.0",
    });
    await markRetainedManagedNpmInstall({
      packageDir,
      pluginId: "kept-plugin",
      reason: RETAINED_MANAGED_NPM_KEEP_FILES_REASON,
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await cleanupRetainedPluginInstallGenerations({ log, startupInstallPaths: [] });

    expect(fs.existsSync(packageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

it.each(["project", "legacy"] as const)(
  "protects startup and desired %s packages when an update precedes idle cleanup",
  async (layout) => {
    await withOpenClawTestState({ label: "gateway-retained-plugin-update" }, async (state) => {
      const writePlugin = (pluginId: string) =>
        writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName: `@openclaw/${pluginId}`,
          pluginId,
          version: "1.0.0",
          layout,
        });
      const startupPackage = writePlugin("startup-plugin");
      const desiredPackage = writePlugin("desired-plugin");
      const obsoletePackage = writePlugin("obsolete-plugin");
      const startupInstallPaths = [path.join(startupPackage, "dist", "index.js")];
      await writePersistedInstalledPluginIndexInstallRecords(
        {
          "desired-plugin": {
            source: "npm",
            spec: "@openclaw/desired-plugin",
            installPath: desiredPackage,
          },
        },
        { env: state.env, candidates: [] },
      );
      for (const packageDir of [startupPackage, desiredPackage, obsoletePackage]) {
        await markRetainedManagedNpmInstall({
          packageDir,
          pluginId: path.basename(packageDir),
          reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
        });
      }
      const log = { info: vi.fn(), warn: vi.fn() };
      const cleanup = { log, startupInstallPaths };

      await cleanupRetainedPluginInstallGenerations(cleanup);

      expect(fs.existsSync(startupPackage)).toBe(true);
      expect(fs.existsSync(desiredPackage)).toBe(true);
      expect(fs.existsSync(obsoletePackage)).toBe(false);
      expect(log.info).toHaveBeenCalledWith("cleaned 1 retained npm plugin generation(s)");
      expect(log.warn).not.toHaveBeenCalled();
    });
  },
);

it("runs the Gateway cleanup owner across invalid and staged markers", async () => {
  await withOpenClawTestState(
    { label: "gateway-retained-plugin-cleanup-boundary" },
    async (state) => {
      const invalidPackageDir = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@openclaw/invalid-plugin",
        pluginId: "invalid-plugin",
        version: "1.0.0",
      });
      await markRetainedManagedNpmInstall({
        packageDir: invalidPackageDir,
        pluginId: "invalid-plugin",
        reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
      });
      fs.writeFileSync(resolveRetainedManagedNpmInstallMarkerPath(invalidPackageDir), "{", "utf8");

      const stagedPackageDir = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@openclaw/codex",
        pluginId: "codex",
        version: "1.0.0",
      });
      await markRetainedManagedNpmInstall({
        packageDir: stagedPackageDir,
        pluginId: "codex",
        reason: RETAINED_MANAGED_NPM_INFERENCE_ACTIVATION_REASON,
      });
      const log = { info: vi.fn(), warn: vi.fn() };

      await cleanupRetainedPluginInstallGenerations({ log, startupInstallPaths: [] });

      expect(fs.existsSync(invalidPackageDir)).toBe(true);
      expect(hasRetainedManagedNpmInstallMarker(invalidPackageDir)).toBe(true);
      expect(fs.existsSync(stagedPackageDir)).toBe(false);
      expect(log.warn).toHaveBeenCalledOnce();
      expect(log.info).toHaveBeenCalledWith("cleaned 1 retained npm plugin generation(s)");
    },
  );
});

it.runIf(process.platform !== "win32")(
  "warns when a legacy retained marker cannot be read",
  async () => {
    await withOpenClawTestState(
      { label: "gateway-retained-plugin-cleanup-access-error" },
      async (state) => {
        const packageDir = writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName: "@openclaw/inaccessible-plugin",
          pluginId: "inaccessible-plugin",
          version: "1.0.0",
          layout: "legacy",
        });
        await markRetainedManagedNpmInstall({
          packageDir,
          pluginId: "inaccessible-plugin",
          reason: RETAINED_MANAGED_NPM_GENERATION_UPDATE_REASON,
        });
        const markerPath = resolveRetainedManagedNpmInstallMarkerPath(packageDir);
        const markerDir = path.dirname(markerPath);
        const log = { info: vi.fn(), warn: vi.fn() };
        fs.chmodSync(markerDir, 0o000);

        try {
          await cleanupRetainedPluginInstallGenerations({ log, startupInstallPaths: [] });
        } finally {
          fs.chmodSync(markerDir, 0o700);
        }

        expect(fs.existsSync(packageDir)).toBe(true);
        expect(fs.existsSync(markerPath)).toBe(true);
        expect(log.info).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledOnce();
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining(`failed to clean retained npm generation ${packageDir}:`),
        );
      },
    );
  },
);
