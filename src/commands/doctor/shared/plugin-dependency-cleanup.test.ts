import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing, cleanupLegacyPluginDependencyState } from "./plugin-dependency-cleanup.js";

describe("cleanupLegacyPluginDependencyState", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-deps-cleanup-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("collects and removes legacy plugin dependency state roots", async () => {
    const stateDir = path.join(tempDir, "state");
    const explicitStageDir = path.join(tempDir, "explicit-stage");
    const stateDirectory = path.join(tempDir, "systemd-state");
    const packageRoot = path.join(tempDir, "package");
    const legacyRuntimeRoot = path.join(stateDir, "plugin-runtime-deps");
    const legacyLocalRoot = path.join(stateDir, ".local", "bundled-plugin-runtime-deps");
    const legacyExtensionNodeModules = path.join(
      packageRoot,
      "dist",
      "extensions",
      "demo",
      "node_modules",
    );
    const legacyManifest = path.join(
      packageRoot,
      "extensions",
      "demo",
      ".openclaw-runtime-deps.json",
    );

    await fs.mkdir(legacyRuntimeRoot, { recursive: true });
    await fs.mkdir(legacyLocalRoot, { recursive: true });
    await fs.mkdir(legacyExtensionNodeModules, { recursive: true });
    await fs.mkdir(path.dirname(legacyManifest), { recursive: true });
    await fs.writeFile(legacyManifest, "{}");
    await fs.mkdir(explicitStageDir, { recursive: true });
    await fs.mkdir(path.join(stateDirectory, "plugin-runtime-deps"), { recursive: true });

    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_PLUGIN_STAGE_DIR: explicitStageDir,
      STATE_DIRECTORY: stateDirectory,
    };
    const targets = await __testing.collectLegacyPluginDependencyTargets(env, { packageRoot });
    expect(targets).toEqual(
      expect.arrayContaining([
        legacyRuntimeRoot,
        legacyLocalRoot,
        legacyExtensionNodeModules,
        legacyManifest,
        explicitStageDir,
        path.join(stateDirectory, "plugin-runtime-deps"),
      ]),
    );

    const result = await cleanupLegacyPluginDependencyState({ env, packageRoot });

    expect(result.warnings).toEqual([]);
    expect(result.changes.length).toBeGreaterThanOrEqual(6);
    await expect(fs.stat(legacyRuntimeRoot)).rejects.toThrow();
    await expect(fs.stat(legacyLocalRoot)).rejects.toThrow();
    await expect(fs.stat(legacyExtensionNodeModules)).rejects.toThrow();
    await expect(fs.stat(legacyManifest)).rejects.toThrow();
    await expect(fs.stat(explicitStageDir)).rejects.toThrow();
    await expect(fs.stat(path.join(stateDirectory, "plugin-runtime-deps"))).rejects.toThrow();
  });
});
