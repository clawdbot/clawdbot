// Covers plugin install path validation and normalization.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { installPluginFromPath, PLUGIN_INSTALL_ERROR_CODE } from "./install.js";
import { packToArchive } from "./test-helpers/archive-fixtures.js";
import { createSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";
import {
  createBundleInstallFixtureFactory,
  createDualFormatInstallFixtureFactory,
} from "./test-helpers/install-fixtures.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

const suiteTempRootTracker = createSuiteTempRootTracker("openclaw-plugin-install-path");
const setupBundleInstallFixture = createBundleInstallFixtureFactory(
  suiteTempRootTracker.makeTempDir,
);
const setupDualFormatInstallFixture = createDualFormatInstallFixtureFactory(
  suiteTempRootTracker.makeTempDir,
);
let dualFormatArchiveCase: {
  nodeModulesExists: boolean;
  result: Awaited<ReturnType<typeof installPluginFromPath>>;
  runCalls: unknown[][];
};

function setupNativePluginInstallFixture() {
  const caseDir = suiteTempRootTracker.makeTempDir();
  const stateDir = path.join(caseDir, "state");
  const pluginDir = path.join(caseDir, "plugin-src");
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "symlink-plugin",
      version: "1.0.0",
      openclaw: { extensions: ["./dist/index.js"] },
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "symlink-plugin",
      configSchema: { type: "object", properties: {} },
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "export {};\n", "utf-8");
  return { caseDir, pluginDir, extensionsDir: path.join(stateDir, "extensions") };
}

afterAll(() => {
  suiteTempRootTracker.cleanup();
});

beforeAll(async () => {
  const { pluginDir, extensionsDir } = setupDualFormatInstallFixture({
    bundleFormat: "claude",
  });
  const archivePath = path.join(suiteTempRootTracker.makeTempDir(), "dual-format.tgz");

  await packToArchive({
    pkgDir: pluginDir,
    outDir: path.dirname(archivePath),
    outName: path.basename(archivePath),
  });

  const run = vi.mocked(runCommandWithTimeout);
  run.mockReset();
  run.mockResolvedValue({
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
  });

  const result = await installPluginFromPath({
    path: archivePath,
    extensionsDir,
  });
  dualFormatArchiveCase = {
    nodeModulesExists: result.ok && fs.existsSync(path.join(result.targetDir, "node_modules")),
    result,
    runCalls: [...run.mock.calls],
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("installPluginFromPath", () => {
  it("rejects managed plain file plugin installs through path install", async () => {
    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "console.log('SAFE');\n", "utf-8");

    const result = await installPluginFromPath({
      path: sourcePath,
      extensionsDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN);
    expect(result.error).toBe(
      "Plain file plugin installs are not supported. Install a plugin directory or archive that contains openclaw.plugin.json, or list standalone plugin files in plugins.load.paths.",
    );
  });

  it.runIf(process.platform !== "win32")(
    "installs local plugin directories when the managed extensions root is a symlink",
    async () => {
      const { caseDir, pluginDir, extensionsDir } = setupNativePluginInstallFixture();
      const realExtensionsDir = path.join(caseDir, "data", "extensions");
      fs.mkdirSync(realExtensionsDir, { recursive: true });
      fs.mkdirSync(path.dirname(extensionsDir), { recursive: true });
      fs.symlinkSync(realExtensionsDir, extensionsDir, "dir");

      const result = await installPluginFromPath({
        path: pluginDir,
        extensionsDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.targetDir).toBe(path.join(extensionsDir, "symlink-plugin"));
      expect(fs.existsSync(path.join(realExtensionsDir, "symlink-plugin", "package.json"))).toBe(
        true,
      );
    },
  );

  it("installs Claude bundles from an archive path", async () => {
    const { pluginDir, extensionsDir } = setupBundleInstallFixture({
      bundleFormat: "claude",
      name: "Claude Sample",
    });
    const archivePath = path.join(suiteTempRootTracker.makeTempDir(), "claude-bundle.tgz");

    await packToArchive({
      pkgDir: pluginDir,
      outDir: path.dirname(archivePath),
      outName: path.basename(archivePath),
    });

    const result = await installPluginFromPath({
      path: archivePath,
      extensionsDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.pluginId).toBe("claude-sample");
    expect(fs.existsSync(path.join(result.targetDir, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("prefers native package metadata without installing dependencies for dual-format archives", async () => {
    const { nodeModulesExists, result, runCalls } = dualFormatArchiveCase;

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.pluginId).toBe("native-dual");
    expect(path.basename(result.targetDir)).toBe("native-dual");
    expect(runCalls).toHaveLength(0);
    expect(nodeModulesExists).toBe(false);
  });
});
