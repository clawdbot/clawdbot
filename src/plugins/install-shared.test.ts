import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installPluginDirectoryIntoExtensions } from "./install-shared.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import { createSyncSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";

describe("installPluginDirectoryIntoExtensions", () => {
  const tempRoots = createSyncSuiteTempRootTracker("openclaw-install-shared");

  afterAll(() => tempRoots.cleanup());

  it("preserves structured warnings returned by a staged dependency scan", async () => {
    const fixtureRoot = tempRoots.makeTempDir();
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(fixtureRoot, "extensions", "demo");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "index.js"), "export default {};\n");
    const installPolicyWarning = {
      targetName: "demo",
      targetType: "plugin" as const,
      requestMode: "install" as const,
      reason: "Review the installed dependency tree",
    };

    const result = await installPluginDirectoryIntoExtensions({
      sourceDir,
      targetDir,
      pluginId: "demo",
      extensions: ["index.js"],
      logger: {},
      timeoutMs: 1_000,
      mode: "install",
      dryRun: false,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: false,
      depsLogMessage: "Installing dependencies…",
      afterInstall: async () => ({
        ok: false,
        error: installPolicyWarning.reason,
        code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED,
        installPolicyWarning,
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: installPolicyWarning.reason,
      code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED,
      installPolicyWarning,
    });
    expect(fs.existsSync(targetDir)).toBe(false);
  });
});
