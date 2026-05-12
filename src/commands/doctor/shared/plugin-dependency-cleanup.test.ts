import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing, cleanupLegacyPluginDependencyState } from "./plugin-dependency-cleanup.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected path to be missing: ${targetPath}`);
}

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
    const legacyExtensionStamp = path.join(
      packageRoot,
      "dist",
      "extensions",
      "demo",
      ".openclaw-runtime-deps-stamp.json",
    );
    const legacyManifest = path.join(
      packageRoot,
      "extensions",
      "demo",
      ".openclaw-runtime-deps.json",
    );
    const thirdPartyNodeModules = path.join(
      stateDir,
      "extensions",
      "lossless-claw",
      "node_modules",
    );

    await fs.mkdir(legacyRuntimeRoot, { recursive: true });
    await fs.mkdir(legacyLocalRoot, { recursive: true });
    await fs.mkdir(legacyExtensionNodeModules, { recursive: true });
    await fs.writeFile(legacyExtensionStamp, "{}");
    await fs.mkdir(path.dirname(legacyManifest), { recursive: true });
    await fs.writeFile(legacyManifest, "{}");
    await fs.mkdir(thirdPartyNodeModules, { recursive: true });
    await fs.mkdir(explicitStageDir, { recursive: true });
    await fs.mkdir(path.join(stateDirectory, "plugin-runtime-deps"), { recursive: true });

    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_PLUGIN_STAGE_DIR: explicitStageDir,
      STATE_DIRECTORY: stateDirectory,
    };
    const targets = await __testing.collectLegacyPluginDependencyTargets(env, { packageRoot });
    expect(targets).toContain(legacyRuntimeRoot);
    expect(targets).toContain(legacyLocalRoot);
    expect(targets).toContain(legacyExtensionNodeModules);
    expect(targets).toContain(legacyExtensionStamp);
    expect(targets).toContain(legacyManifest);
    expect(targets).toContain(explicitStageDir);
    expect(targets).toContain(path.join(stateDirectory, "plugin-runtime-deps"));
    expect(targets).not.toContain(thirdPartyNodeModules);

    const result = await cleanupLegacyPluginDependencyState({ env, packageRoot });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.length).toBeGreaterThanOrEqual(6);
    await expectPathMissing(legacyRuntimeRoot);
    await expectPathMissing(legacyLocalRoot);
    await expectPathMissing(legacyExtensionNodeModules);
    await expectPathMissing(legacyExtensionStamp);
    await expectPathMissing(legacyManifest);
    expect((await fs.stat(thirdPartyNodeModules)).isDirectory()).toBe(true);
    await expectPathMissing(explicitStageDir);
    await expectPathMissing(path.join(stateDirectory, "plugin-runtime-deps"));
  });

  it("removes dangling global plugin-runtime symlinks that point at legacy runtime deps", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "prefix", "lib", "node_modules", "openclaw");
    const nodeModulesRoot = path.dirname(packageRoot);
    const legacyRuntimeRoot = path.join(stateDir, "plugin-runtime-deps");
    const legacyTarget = path.join(
      legacyRuntimeRoot,
      "openclaw-2026.4.29-slack",
      "node_modules",
      "@slack",
      "web-api",
    );
    const slackScope = path.join(nodeModulesRoot, "@slack");
    const slackLink = path.join(slackScope, "web-api");
    const liveTarget = path.join(tempDir, "live", "@slack", "bolt");
    const liveLink = path.join(slackScope, "bolt");

    await fs.mkdir(legacyTarget, { recursive: true });
    await fs.writeFile(path.join(legacyTarget, "package.json"), "{}\n");
    await fs.mkdir(liveTarget, { recursive: true });
    await fs.writeFile(path.join(liveTarget, "package.json"), "{}\n");
    await fs.mkdir(slackScope, { recursive: true });
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.symlink(legacyTarget, slackLink, "dir");
    await fs.symlink(liveTarget, liveLink, "dir");

    const result = await cleanupLegacyPluginDependencyState({
      env: { OPENCLAW_STATE_DIR: stateDir },
      packageRoot,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      `Removed stale plugin-runtime symlink: ${slackLink}`,
      `Removed legacy plugin dependency state: ${legacyRuntimeRoot}`,
    ]);
    await expectPathMissing(slackLink);
    expect((await fs.lstat(liveLink)).isSymbolicLink()).toBe(true);
  });
});
