import fs from "node:fs";
import { expect, it, vi } from "vitest";
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

    await cleanupRetainedPluginInstallGenerations({ log });

    expect(fs.existsSync(packageDir)).toBe(true);
    expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
