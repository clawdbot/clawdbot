import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { expectSingleNpmInstallIgnoreScriptsCall } from "../test-utils/exec-assertions.js";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";
import {
  installPluginFromFile,
  installPluginFromPath,
  PLUGIN_INSTALL_ERROR_CODE,
} from "./install.js";
import { packToArchive } from "./test-helpers/archive-fixtures.js";
import { createSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

const suiteTempRootTracker = createSuiteTempRootTracker("openclaw-plugin-install-path");

function setupBundleInstallFixture(params: {
  bundleFormat: "codex" | "claude" | "cursor";
  name: string;
}) {
  const caseDir = suiteTempRootTracker.makeTempDir();
  const stateDir = path.join(caseDir, "state");
  const pluginDir = path.join(caseDir, "plugin-src");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
  const manifestDir = path.join(
    pluginDir,
    params.bundleFormat === "codex"
      ? ".codex-plugin"
      : params.bundleFormat === "cursor"
        ? ".cursor-plugin"
        : ".claude-plugin",
  );
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify({
      name: params.name,
      description: `${params.bundleFormat} bundle fixture`,
      ...(params.bundleFormat === "codex" ? { skills: "skills" } : {}),
    }),
    "utf-8",
  );
  if (params.bundleFormat === "cursor") {
    fs.mkdirSync(path.join(pluginDir, ".cursor", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".cursor", "commands", "review.md"),
      "---\ndescription: fixture\n---\n",
      "utf-8",
    );
  }
  fs.writeFileSync(
    path.join(pluginDir, "skills", "SKILL.md"),
    "---\ndescription: fixture\n---\n",
    "utf-8",
  );
  return { pluginDir, extensionsDir: path.join(stateDir, "extensions") };
}

function setupDualFormatInstallFixture(params: { bundleFormat: "codex" | "claude" }) {
  const caseDir = suiteTempRootTracker.makeTempDir();
  const stateDir = path.join(caseDir, "state");
  const pluginDir = path.join(caseDir, "plugin-src");
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
  const manifestDir = path.join(
    pluginDir,
    params.bundleFormat === "codex" ? ".codex-plugin" : ".claude-plugin",
  );
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/native-dual",
      version: "0.0.1",
      openclaw: { extensions: ["./dist/index.js"] },
      dependencies: { "left-pad": "1.3.0" },
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "native-dual",
      configSchema: { type: "object", properties: {} },
      skills: ["skills"],
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "export {};", "utf-8");
  fs.writeFileSync(path.join(pluginDir, "skills", "SKILL.md"), "---\ndescription: fixture\n---\n");
  fs.writeFileSync(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify({
      name: "Bundle Fallback",
      ...(params.bundleFormat === "codex" ? { skills: "skills" } : {}),
    }),
    "utf-8",
  );
  return { pluginDir, extensionsDir: path.join(stateDir, "extensions") };
}

async function installFromFileWithWarnings(params: {
  extensionsDir: string;
  filePath: string;
  dangerouslyForceUnsafeInstall?: boolean;
}) {
  const warnings: string[] = [];
  const result = await installPluginFromFile({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    filePath: params.filePath,
    extensionsDir: params.extensionsDir,
    logger: {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
    },
  });
  return { result, warnings };
}

afterAll(() => {
  suiteTempRootTracker.cleanup();
});

beforeEach(() => {
  resetGlobalHookRunner();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("installPluginFromPath", () => {
  it("runs before_install for plain file plugins with file provenance metadata", async () => {
    const handler = vi.fn().mockReturnValue({
      findings: [
        {
          ruleId: "manual-review",
          severity: "warn",
          file: "payload.js",
          line: 1,
          message: "Review single-file plugin before install",
        },
      ],
    });
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "console.log('SAFE');\n", "utf-8");

    const result = await installPluginFromFile({
      filePath: sourcePath,
      extensionsDir,
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      targetName: "payload",
      targetType: "plugin",
      origin: "plugin-file",
      sourcePath,
      sourcePathKind: "file",
      request: {
        kind: "plugin-file",
        mode: "install",
        requestedSpecifier: sourcePath,
      },
      builtinScan: {
        status: "ok",
      },
      plugin: {
        contentType: "file",
        pluginId: "payload",
        extensions: ["payload.js"],
      },
    });
    expect(handler.mock.calls[0]?.[1]).toEqual({
      origin: "plugin-file",
      targetType: "plugin",
      requestKind: "plugin-file",
    });
  });

  it("blocks plain file installs when the scanner finds dangerous code patterns", async () => {
    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "eval('danger');\n", "utf-8");

    const { result, warnings } = await installFromFileWithWarnings({
      filePath: sourcePath,
      extensionsDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED);
      expect(result.error).toContain('Plugin file "payload" installation blocked');
    }
    expect(warnings.some((w) => w.includes("dangerous code pattern"))).toBe(true);
  });

  it("allows plain file installs with dangerous code patterns when forced unsafe install is set", async () => {
    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "eval('danger');\n", "utf-8");

    const { result, warnings } = await installFromFileWithWarnings({
      filePath: sourcePath,
      extensionsDir,
      dangerouslyForceUnsafeInstall: true,
    });

    expect(result.ok).toBe(true);
    expect(
      warnings.some((warning) =>
        warning.includes(
          "forced despite dangerous code patterns via --dangerously-force-unsafe-install",
        ),
      ),
    ).toBe(true);
  });

  it("blocks hardlink alias overwrites when installing a plain file plugin", async () => {
    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    const outsideDir = path.join(baseDir, "outside");
    fs.mkdirSync(extensionsDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "console.log('SAFE');\n", "utf-8");
    const victimPath = path.join(outsideDir, "victim.js");
    fs.writeFileSync(victimPath, "ORIGINAL", "utf-8");

    const targetPath = path.join(extensionsDir, "payload.js");
    fs.linkSync(victimPath, targetPath);

    const result = await installPluginFromPath({
      path: sourcePath,
      extensionsDir,
      mode: "update",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.toLowerCase()).toMatch(/hardlink|path alias escape/);
    expect(fs.readFileSync(victimPath, "utf-8")).toBe("ORIGINAL");
  });

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

  it("prefers native package installs over bundle installs for dual-format archives", async () => {
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
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.pluginId).toBe("native-dual");
    expect(result.targetDir).toBe(path.join(extensionsDir, "native-dual"));
    expectSingleNpmInstallIgnoreScriptsCall({
      calls: run.mock.calls as Array<[unknown, { cwd?: string } | undefined]>,
      expectedTargetDir: result.targetDir,
    });
  });
});
