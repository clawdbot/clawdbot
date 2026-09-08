import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writePersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { RETAINED_MANAGED_NPM_KEEP_FILES_REASON } from "../plugins/managed-npm-retention-contract.js";
import {
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
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
          reason: "replaced-plugin-generation",
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
