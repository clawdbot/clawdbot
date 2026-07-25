// Plugin dependency cleanup tests cover doctor cleanup of stale plugin dependencies.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupLegacyPluginDependencyState,
  detectLegacyPluginDependencyStateIssues,
  legacyPluginDependencyStateIssueToHealthFinding,
} from "./plugin-dependency-cleanup.js";
import { collectLegacyPluginDependencyTargets } from "./plugin-dependency-cleanup.test-support.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected path to be missing: ${targetPath}`);
}

async function expectDirectoryPresent(targetPath: string): Promise<void> {
  expect((await fs.stat(targetPath)).isDirectory()).toBe(true);
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
    const explicitStageDir = path.join(stateDir, ".openclaw-install-stage-explicit");
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
    const targets = await collectLegacyPluginDependencyTargets(env, { packageRoot });
    expect(targets).toContain(legacyRuntimeRoot);
    expect(targets).toContain(legacyLocalRoot);
    expect(targets).toContain(legacyExtensionNodeModules);
    expect(targets).toContain(legacyExtensionStamp);
    expect(targets).toContain(legacyManifest);
    expect(targets).toContain(explicitStageDir);
    expect(targets).toContain(path.join(stateDirectory, "plugin-runtime-deps"));
    expect(targets).not.toContain(thirdPartyNodeModules);

    const issues = await detectLegacyPluginDependencyStateIssues({ env, packageRoot });
    expect(issues).toContainEqual({
      kind: "legacy-plugin-dependency-state",
      path: legacyRuntimeRoot,
    });
    expect(issues).toContainEqual({
      kind: "legacy-plugin-dependency-state",
      path: legacyLocalRoot,
    });
    expect(issues).toContainEqual({
      kind: "legacy-plugin-dependency-state",
      path: explicitStageDir,
    });
    expect(issues.some((issue) => issue.path === thirdPartyNodeModules)).toBe(false);
    await expectDirectoryPresent(legacyRuntimeRoot);

    const result = await cleanupLegacyPluginDependencyState({ env, packageRoot });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.length).toBeGreaterThanOrEqual(6);
    await expectPathMissing(legacyRuntimeRoot);
    await expectPathMissing(legacyLocalRoot);
    await expectPathMissing(legacyExtensionNodeModules);
    await expectPathMissing(legacyExtensionStamp);
    await expectPathMissing(legacyManifest);
    await expectDirectoryPresent(thirdPartyNodeModules);
    await expectPathMissing(explicitStageDir);
    await expectPathMissing(path.join(stateDirectory, "plugin-runtime-deps"));
  });

  it("removes configured plugin stage roots outside OpenClaw roots", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "package");
    const stageRoot = path.join(tempDir, "stage");

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(path.join(stageRoot, "node_modules", "ansi-escapes"), { recursive: true });
    await fs.writeFile(
      path.join(stageRoot, "node_modules", "ansi-escapes", ".openclaw-rename-tmp"),
      "corrupt rename residue\n",
    );

    const result = await cleanupLegacyPluginDependencyState({
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_PLUGIN_STAGE_DIR: stageRoot,
      },
      packageRoot,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(`Removed legacy plugin dependency state: ${stageRoot}`);
    await expectPathMissing(stageRoot);
  });

  it("maps legacy dependency state issues to lint findings", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "package");
    const legacyRuntimeRoot = path.join(stateDir, "plugin-runtime-deps");

    await fs.mkdir(legacyRuntimeRoot, { recursive: true });
    await fs.mkdir(packageRoot, { recursive: true });

    const [issue] = await detectLegacyPluginDependencyStateIssues({
      env: { OPENCLAW_STATE_DIR: stateDir },
      packageRoot,
    });

    expect(issue).toEqual({
      kind: "legacy-plugin-dependency-state",
      path: legacyRuntimeRoot,
    });
    expect(
      legacyPluginDependencyStateIssueToHealthFinding(expectDefined(issue, "issue test invariant")),
    ).toEqual({
      checkId: "core/doctor/legacy-plugin-dependencies",
      severity: "warning",
      message: `Legacy plugin dependency state remains at ${legacyRuntimeRoot}.`,
      target: legacyRuntimeRoot,
      path: legacyRuntimeRoot,
      requirement: "legacy-plugin-dependency-state-removed",
      fixHint: "Run `openclaw doctor --fix` to remove legacy plugin dependency state.",
    });
    await expectDirectoryPresent(legacyRuntimeRoot);
  });

  it("refuses arbitrary explicit plugin stage roots outside OpenClaw roots", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "package");
    const stageRoot = path.join(tempDir, "stage-without-marker");

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(path.join(stageRoot, "node_modules", "ansi-escapes"), { recursive: true });

    const result = await cleanupLegacyPluginDependencyState({
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_PLUGIN_STAGE_DIR: stageRoot,
      },
      packageRoot,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toContain(
      `Skipped legacy plugin dependency state ${stageRoot}: unexpected path name`,
    );
    await expectDirectoryPresent(stageRoot);
  });

  it("refuses explicit plugin stage paths with parent segments", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "package");
    const dotDotStage = `${stateDir}${path.sep}..${path.sep}.openclaw-install-stage-dotdot`;
    const resolvedDotDotStage = path.resolve(dotDotStage);

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(resolvedDotDotStage, { recursive: true });

    const result = await cleanupLegacyPluginDependencyState({
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_PLUGIN_STAGE_DIR: dotDotStage,
      },
      packageRoot,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toContain(
      `Skipped legacy plugin dependency state ${resolvedDotDotStage}: parent path segments are not allowed`,
    );
    await expectDirectoryPresent(resolvedDotDotStage);
  });

  it("does not follow symlinked extension roots outside OpenClaw roots", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "package");
    const extensionsRoot = path.join(packageRoot, "extensions");
    const linkedPlugin = path.join(extensionsRoot, "linked-plugin");
    const externalPlugin = path.join(tempDir, "external-plugin");
    const externalNodeModules = path.join(externalPlugin, "node_modules");

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(extensionsRoot, { recursive: true });
    await fs.mkdir(externalNodeModules, { recursive: true });
    await fs.writeFile(path.join(externalPlugin, ".openclaw-runtime-deps.json"), "{}");
    await fs.symlink(externalPlugin, linkedPlugin, "dir");

    const targets = await collectLegacyPluginDependencyTargets(
      { OPENCLAW_STATE_DIR: stateDir },
      { packageRoot },
    );
    expect(targets).not.toContain(path.join(linkedPlugin, "node_modules"));

    const result = await cleanupLegacyPluginDependencyState({
      env: { OPENCLAW_STATE_DIR: stateDir },
      packageRoot,
    });

    expect(result.warnings).toStrictEqual([]);
    await expectDirectoryPresent(externalNodeModules);
  });

  it("refuses legacy roots that resolve outside OpenClaw roots", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "package");
    const legacyRuntimeRoot = path.join(stateDir, "plugin-runtime-deps");
    const externalRuntimeRoot = path.join(tempDir, "external-runtime");

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(externalRuntimeRoot, { recursive: true });
    await fs.symlink(externalRuntimeRoot, legacyRuntimeRoot, "dir");

    const result = await cleanupLegacyPluginDependencyState({
      env: { OPENCLAW_STATE_DIR: stateDir },
      packageRoot,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toContain(
      `Skipped legacy plugin dependency state ${legacyRuntimeRoot}: resolved outside OpenClaw cleanup roots`,
    );
    expect((await fs.lstat(legacyRuntimeRoot)).isSymbolicLink()).toBe(true);
    await expectDirectoryPresent(externalRuntimeRoot);
  });

  it("does not unlink global runtime symlinks through unsafe cleanup roots", async () => {
    const stateDir = path.join(tempDir, "state");
    const packageRoot = path.join(tempDir, "prefix", "lib", "node_modules", "openclaw");
    const nodeModulesRoot = path.dirname(packageRoot);
    const legacyRuntimeRoot = path.join(stateDir, "plugin-runtime-deps");
    const externalRuntimeRoot = path.join(tempDir, "external-runtime");
    const activeRuntimeTarget = path.join(
      externalRuntimeRoot,
      "openclaw-external",
      "node_modules",
      "left-pad",
    );
    const unsafeRuntimeTarget = path.join(
      legacyRuntimeRoot,
      "openclaw-external",
      "node_modules",
      "left-pad",
    );
    const leftPadLink = path.join(nodeModulesRoot, "left-pad");

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(activeRuntimeTarget, { recursive: true });
    await fs.symlink(externalRuntimeRoot, legacyRuntimeRoot, "dir");
    await fs.symlink(unsafeRuntimeTarget, leftPadLink, "dir");

    const result = await cleanupLegacyPluginDependencyState({
      env: { OPENCLAW_STATE_DIR: stateDir },
      packageRoot,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toContain(
      `Skipped legacy plugin dependency state ${legacyRuntimeRoot}: resolved outside OpenClaw cleanup roots`,
    );
    expect((await fs.lstat(leftPadLink)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(legacyRuntimeRoot)).isSymbolicLink()).toBe(true);
    await expectDirectoryPresent(activeRuntimeTarget);
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
