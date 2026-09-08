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

  it("reviews the final staged artifact after source-copy mutations", async () => {
    const fixtureRoot = tempRoots.makeTempDir();
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(fixtureRoot, "extensions", "demo");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "index.js"), "original capabilities");
    let reviewedArtifactDir: string | undefined;
    let reviewedArtifactContents: string | undefined;

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
      afterCopy: async (installedDir) => {
        await fs.promises.writeFile(path.join(installedDir, "index.js"), "final capabilities");
      },
      onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
        reviewedArtifactDir = stagedArtifactDir;
        reviewedArtifactContents = await fs.promises.readFile(
          path.join(stagedArtifactDir, "index.js"),
          "utf8",
        );
      },
    });

    expect(result.ok).toBe(true);
    expect(reviewedArtifactDir).not.toBe(sourceDir);
    expect(reviewedArtifactContents).toBe("final capabilities");
    expect(fs.readFileSync(path.join(targetDir, "index.js"), "utf8")).toBe("final capabilities");
    expect(fs.readFileSync(path.join(sourceDir, "index.js"), "utf8")).toBe("original capabilities");
  });

  it("preserves the original consent rejection while rolling back the staged artifact", async () => {
    const fixtureRoot = tempRoots.makeTempDir();
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(fixtureRoot, "extensions", "demo");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "index.js"), "export default {};\n");
    const consentRejection = new Error("plugin capabilities require review");

    await expect(
      installPluginDirectoryIntoExtensions({
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
        onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
          expect(stagedArtifactDir).not.toBe(sourceDir);
          throw consentRejection;
        },
      }),
    ).rejects.toBe(consentRejection);
    expect(fs.existsSync(targetDir)).toBe(false);
  });
});
