import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as stageBundledPluginRuntimeDepsTesting,
  collectRuntimeDependencyInstallManifest,
  collectRuntimeDependencyInstallSpecs,
  stageBundledPluginRuntimeDeps,
} from "../../scripts/stage-bundled-plugin-runtime-deps.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

type RuntimeDepsStampParams = {
  fingerprint: string;
  stampPath: string;
};

describe("stageBundledPluginRuntimeDeps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createBundledPluginFixture(params: {
    packageJson: Record<string, unknown>;
    pluginId?: string;
  }) {
    const repoRoot = createTempDir("openclaw-runtime-deps-");
    const pluginId = params.pluginId ?? "fixture-plugin";
    const pluginDir = path.join(repoRoot, "dist", "extensions", pluginId);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify(params.packageJson, null, 2)}\n`,
      "utf8",
    );
    return { pluginDir, repoRoot };
  }

  function writeRuntimeDepsStamp(stampPath: string, fingerprint: string) {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, `${JSON.stringify({ fingerprint }, null, 2)}\n`, "utf8");
  }

  function runtimeDepsStampPath(repoRoot: string, pluginId = "fixture-plugin") {
    return path.join(repoRoot, ".artifacts", "bundled-runtime-deps-stamps", `${pluginId}.json`);
  }

  it("pins fallback install specs to exact installed versions", () => {
    const { repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: {
          direct: "^1.0.0",
        },
        optionalDependencies: {
          optional: "~2.0.0",
        },
      },
    });
    const rootNodeModulesDir = path.join(repoRoot, "node_modules");
    fs.mkdirSync(path.join(rootNodeModulesDir, "direct"), { recursive: true });
    fs.mkdirSync(path.join(rootNodeModulesDir, "optional"), { recursive: true });
    fs.writeFileSync(
      path.join(rootNodeModulesDir, "direct", "package.json"),
      '{ "name": "direct", "version": "1.2.3" }\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(rootNodeModulesDir, "optional", "package.json"),
      '{ "name": "optional", "version": "2.0.4" }\n',
      "utf8",
    );

    expect(
      collectRuntimeDependencyInstallSpecs(
        {
          dependencies: { direct: "^1.0.0" },
          optionalDependencies: { optional: "~2.0.0" },
        },
        { rootNodeModulesDir },
      ),
    ).toEqual({
      dependencies: ["direct@1.2.3"],
      optionalDependencies: ["optional@2.0.4"],
    });
  });

  it("rejects unsafe runtime dependency specs for fallback installs", () => {
    expect(() =>
      collectRuntimeDependencyInstallSpecs(
        {
          dependencies: { direct: "file:/etc/passwd" },
        },
        { rootNodeModulesDir: "/tmp/node_modules" },
      ),
    ).toThrow(/disallowed runtime dependency spec for direct: file:\/etc\/passwd/u);
  });

  it("writes required and optional fallback deps into one manifest", () => {
    const rootNodeModulesDir = createTempDir("openclaw-runtime-deps-manifest-");
    fs.mkdirSync(path.join(rootNodeModulesDir, "direct"), { recursive: true });
    fs.mkdirSync(path.join(rootNodeModulesDir, "optional"), { recursive: true });
    fs.writeFileSync(
      path.join(rootNodeModulesDir, "direct", "package.json"),
      '{ "name": "direct", "version": "1.2.3" }\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(rootNodeModulesDir, "optional", "package.json"),
      '{ "name": "optional", "version": "2.0.4" }\n',
      "utf8",
    );

    expect(
      collectRuntimeDependencyInstallManifest(
        {
          dependencies: { direct: "^1.0.0" },
          optionalDependencies: { optional: "~2.0.0" },
        },
        { pluginId: "fixture-plugin", rootNodeModulesDir },
      ),
    ).toEqual({
      name: "openclaw-runtime-deps-fixture-plugin",
      private: true,
      version: "0.0.0",
      dependencies: { direct: "1.2.3" },
      optionalDependencies: { optional: "2.0.4" },
    });
  });

  it("hides npm child windows during fallback runtime installs", () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    stageBundledPluginRuntimeDepsTesting.runNpmInstall({
      cwd: "C:\\openclaw\\dist\\extensions\\telegram\\.openclaw-install-stage",
      npmRunner: {
        command: "npm.cmd",
        args: ["install", "--silent"],
        env: { PATH: "C:\\node" },
        shell: false,
        windowsVerbatimArguments: true,
      },
      spawnSyncImpl,
    });

    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "npm.cmd",
      ["install", "--silent"],
      expect.objectContaining({
        windowsHide: true,
        windowsVerbatimArguments: true,
      }),
    );
  });

  it("forces fallback runtime installs off inherited npm dry-run mode", () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

    stageBundledPluginRuntimeDepsTesting.runNpmInstall({
      cwd: "/tmp/openclaw-runtime-deps",
      npmRunner: {
        command: "npm",
        args: ["install"],
        env: { PATH: "/usr/bin", npm_config_dry_run: "true" },
        shell: false,
      },
      spawnSyncImpl,
    });

    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "npm",
      ["install"],
      expect.objectContaining({
        env: expect.objectContaining({
          npm_config_dry_run: "false",
        }),
      }),
    );
  });

  it("skips restaging when runtime deps stamp matches the sanitized manifest", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        peerDependencies: {
          "@openclaw/plugin-sdk": "workspace:*",
          openclaw: "^1.0.0",
          react: "^19.0.0",
        },
        peerDependenciesMeta: {
          "@openclaw/plugin-sdk": { optional: true },
          openclaw: { optional: true },
          react: { optional: true },
        },
        devDependencies: {
          "@openclaw/plugin-sdk": "workspace:*",
          openclaw: "^1.0.0",
          typescript: "^5.9.0",
        },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "present\n", "utf8");

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        installCount += 1;
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: () => {
        installCount += 1;
      },
    });

    expect(installCount).toBe(1);
    expect(fs.existsSync(path.join(nodeModulesDir, "marker.txt"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"))).toEqual({
      name: "@openclaw/fixture-plugin",
      version: "1.0.0",
      dependencies: { "left-pad": "1.3.0" },
      openclaw: { bundle: { stageRuntimeDependencies: true } },
    });
  });

  it("restages when the manifest-owned runtime deps change", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    const stageOnce = () =>
      stageBundledPluginRuntimeDeps({
        cwd: repoRoot,
        installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
          installCount += 1;
          const nodeModulesDir = path.join(pluginDir, "node_modules");
          fs.mkdirSync(nodeModulesDir, { recursive: true });
          fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), `${installCount}\n`, "utf8");
          writeRuntimeDepsStamp(stampPath, fingerprint);
        },
      });

    stageOnce();
    const updatedPackageJson = JSON.parse(
      fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"),
    );
    updatedPackageJson.dependencies["is-odd"] = "3.0.1";
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify(updatedPackageJson, null, 2)}\n`,
      "utf8",
    );
    stageOnce();

    expect(installCount).toBe(2);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe("2\n");
  });

  it("restages when the root pnpm lockfile changes", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    fs.writeFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    let installCount = 0;
    const stageOnce = () =>
      stageBundledPluginRuntimeDeps({
        cwd: repoRoot,
        installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
          installCount += 1;
          const nodeModulesDir = path.join(pluginDir, "node_modules");
          fs.mkdirSync(nodeModulesDir, { recursive: true });
          fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), `${installCount}\n`, "utf8");
          writeRuntimeDepsStamp(stampPath, fingerprint);
        },
      });

    stageOnce();
    fs.writeFileSync(
      path.join(repoRoot, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\npatchedDependencies:\n  left-pad@1.3.0: patches/left-pad.patch\n",
      "utf8",
    );
    stageOnce();

    expect(installCount).toBe(2);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe("2\n");
  });

  it("retries stale temp dir cleanup races before staging runtime deps", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const staleTempDir = path.join(pluginDir, ".openclaw-runtime-deps-copy-stale");
    fs.mkdirSync(staleTempDir, { recursive: true });
    fs.writeFileSync(path.join(staleTempDir, "marker.txt"), "stale\n", "utf8");
    const realRmSync = fs.rmSync.bind(fs);
    let cleanupAttempts = 0;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target) === staleTempDir && cleanupAttempts === 0) {
        cleanupAttempts += 1;
        const error = new Error("Directory not empty") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      if (String(target) === staleTempDir) {
        cleanupAttempts += 1;
      }
      return realRmSync(target, options);
    });

    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        const nodeModulesDir = path.join(pluginDir, "node_modules");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "installed\n", "utf8");
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(cleanupAttempts).toBe(2);
    expect(fs.existsSync(staleTempDir)).toBe(false);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe(
      "installed\n",
    );
  });

  it("keeps runtime deps temp dirs owned by a live build process", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const activeTempDir = path.join(pluginDir, ".openclaw-runtime-deps-stage-active");
    fs.mkdirSync(activeTempDir, { recursive: true });
    stageBundledPluginRuntimeDepsTesting.writeRuntimeDepsTempOwner(activeTempDir);
    fs.writeFileSync(path.join(activeTempDir, "marker.txt"), "active\n", "utf8");

    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        const nodeModulesDir = path.join(pluginDir, "node_modules");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "installed\n", "utf8");
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(fs.readFileSync(path.join(activeTempDir, "marker.txt"), "utf8")).toBe("active\n");
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe(
      "installed\n",
    );
  });

  it("restores atomically replaced dirs when concurrent cleanup runs during rename failure", () => {
    const parentDir = createTempDir("openclaw-runtime-deps-replace-");
    const targetPath = path.join(parentDir, "node_modules");
    const sourcePath = path.join(parentDir, "source-node_modules");
    fs.mkdirSync(targetPath, { recursive: true });
    fs.writeFileSync(path.join(targetPath, "marker.txt"), "original\n", "utf8");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "marker.txt"), "replacement\n", "utf8");

    const realRenameSync = fs.renameSync.bind(fs);
    let backupPath: string | null = null;
    vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      const oldPathString = String(oldPath);
      const newPathString = String(newPath);
      if (
        oldPathString === targetPath &&
        path.basename(newPathString).startsWith(".openclaw-runtime-deps-backup-")
      ) {
        backupPath = newPathString;
        return realRenameSync(oldPath, newPath);
      }
      if (oldPathString === sourcePath && newPathString === targetPath) {
        expect(backupPath).not.toBeNull();
        stageBundledPluginRuntimeDepsTesting.removeStaleRuntimeDepsTempDirs(parentDir);
        expect(fs.existsSync(path.join(backupPath ?? "", "marker.txt"))).toBe(true);
        throw new Error("rename failed after backup");
      }
      return realRenameSync(oldPath, newPath);
    });

    expect(() =>
      stageBundledPluginRuntimeDepsTesting.replaceDirAtomically(targetPath, sourcePath),
    ).toThrow("rename failed after backup");

    expect(fs.readFileSync(path.join(targetPath, "marker.txt"), "utf8")).toBe("original\n");
    expect(fs.existsSync(path.join(targetPath, "owner.json"))).toBe(false);
  });

  it("retries transient backup cleanup during atomic replace", () => {
    const parentDir = createTempDir("openclaw-runtime-deps-replace-");
    const targetPath = path.join(parentDir, "node_modules");
    const sourcePath = path.join(parentDir, "source-node_modules");
    fs.mkdirSync(targetPath, { recursive: true });
    fs.writeFileSync(path.join(targetPath, "marker.txt"), "original\n", "utf8");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "marker.txt"), "replacement\n", "utf8");

    const realRmSync = fs.rmSync.bind(fs);
    let transientFailures = 0;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      const targetString = String(target);
      if (
        targetString.includes(`${path.sep}.openclaw-runtime-deps-backup-`) &&
        transientFailures < 2
      ) {
        transientFailures += 1;
        const error = new Error("transient backup cleanup failure") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      return realRmSync(target, options);
    });

    stageBundledPluginRuntimeDepsTesting.replaceDirAtomically(targetPath, sourcePath);

    expect(transientFailures).toBe(2);
    expect(fs.readFileSync(path.join(targetPath, "marker.txt"), "utf8")).toBe("replacement\n");
  });

  it("keeps a successful replacement when backup cleanup hits transient ENOTEMPTY", () => {
    const parentDir = createTempDir("openclaw-runtime-deps-replace-cleanup-");
    const targetPath = path.join(parentDir, "node_modules");
    const sourcePath = path.join(parentDir, "source-node_modules");
    fs.mkdirSync(targetPath, { recursive: true });
    fs.writeFileSync(path.join(targetPath, "marker.txt"), "original\n", "utf8");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "marker.txt"), "replacement\n", "utf8");

    const realRenameSync = fs.renameSync.bind(fs);
    const realRmSync = fs.rmSync.bind(fs);
    let backupPath: string | null = null;
    vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      const oldPathString = String(oldPath);
      const newPathString = String(newPath);
      if (
        oldPathString === targetPath &&
        path.basename(newPathString).startsWith(".openclaw-runtime-deps-backup-")
      ) {
        backupPath = newPathString;
      }
      return realRenameSync(oldPath, newPath);
    });
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      const targetString = String(target);
      if (
        backupPath &&
        targetString === backupPath &&
        fs.existsSync(path.join(backupPath, "marker.txt"))
      ) {
        const error = new Error("Directory not empty") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      return realRmSync(target, options);
    });

    expect(() =>
      stageBundledPluginRuntimeDepsTesting.replaceDirAtomically(targetPath, sourcePath),
    ).not.toThrow();

    expect(fs.readFileSync(path.join(targetPath, "marker.txt"), "utf8")).toBe("replacement\n");
    expect(backupPath).not.toBeNull();
    expect(fs.readFileSync(path.join(backupPath ?? "", "marker.txt"), "utf8")).toBe("original\n");
    expect(fs.existsSync(path.join(backupPath ?? "", "owner.json"))).toBe(true);
  });

  it("keeps successful root staging when owned stage temp cleanup races", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");

    const realRmSync = fs.rmSync.bind(fs);
    let cleanupAttempts = 0;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      const targetString = String(target);
      if (
        targetString.startsWith(path.join(pluginDir, ".openclaw-runtime-deps-stage-")) &&
        cleanupAttempts === 0
      ) {
        cleanupAttempts += 1;
        const error = new Error("Directory not empty") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      if (targetString.startsWith(path.join(pluginDir, ".openclaw-runtime-deps-stage-"))) {
        cleanupAttempts += 1;
      }
      return realRmSync(target, options);
    });

    expect(() => stageBundledPluginRuntimeDeps({ cwd: repoRoot })).not.toThrow();

    expect(cleanupAttempts).toBe(2);
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'direct';\n");
  });

  it("restages when installed root runtime dependency contents change", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'first';\n", "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'first';\n");

    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'second';\n", "utf8");
    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'second';\n");
  });

  it("restages when plugin-local installed runtime dependency contents change", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDirectDir = path.join(repoRoot, "node_modules", "direct");
    const sourcePluginDir = path.join(repoRoot, "extensions", "fixture-plugin");
    const pluginDirectDir = path.join(sourcePluginDir, "node_modules", "direct");
    fs.mkdirSync(rootDirectDir, { recursive: true });
    fs.mkdirSync(pluginDirectDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourcePluginDir, "package.json"),
      '{ "name": "@openclaw/fixture-plugin", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(rootDirectDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(rootDirectDir, "index.js"), "module.exports = 'root';\n", "utf8");
    fs.writeFileSync(
      path.join(pluginDirectDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDirectDir, "index.js"), "module.exports = 'first';\n", "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'first';\n");

    fs.writeFileSync(
      path.join(pluginDirectDir, "index.js"),
      "module.exports = 'second';\n",
      "utf8",
    );
    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'second';\n");
  });

  it("fingerprints regular files when readdir reports symlink-like entries", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");

    const realReaddirSync = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation(((target, options) => {
      const result = realReaddirSync(target, options as never);
      if (
        String(target) !== directDir ||
        typeof options !== "object" ||
        options === null ||
        !("withFileTypes" in options) ||
        options.withFileTypes !== true
      ) {
        return result;
      }
      return (result as fs.Dirent[]).map((entry) => {
        if (entry.name !== "package.json") {
          return entry;
        }
        return {
          ...entry,
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        } as fs.Dirent;
      }) as never;
    }) as typeof fs.readdirSync);

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: () => {
        installCount += 1;
        throw new Error("unexpected fallback install");
      },
    });

    expect(installCount).toBe(0);
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'direct';\n");
  });

  it("refuses to replace a symlinked plugin node_modules directory", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    const outsideDir = path.join(repoRoot, "outside-node-modules");
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    fs.mkdirSync(directDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");
    fs.symlinkSync(outsideDir, nodeModulesDir);

    expect(() => stageBundledPluginRuntimeDeps({ cwd: repoRoot })).toThrow(
      /refusing to replace runtime deps via symlinked path/u,
    );
  });

  it("refuses to write a runtime deps stamp through a symlink", () => {
    const { repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    const outsideStamp = path.join(repoRoot, "outside-stamp.json");
    const stampPath = runtimeDepsStampPath(repoRoot);
    fs.mkdirSync(directDir, { recursive: true });
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");
    fs.writeFileSync(outsideStamp, '{"outside":true}\n', "utf8");
    fs.symlinkSync(outsideStamp, stampPath);

    expect(() => stageBundledPluginRuntimeDeps({ cwd: repoRoot })).toThrow(
      /refusing to write runtime deps stamp via symlinked path/u,
    );
  });

  it("stages runtime deps from the root node_modules when already installed", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "left-pad");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDepDir, "package.json"),
      '{ "name": "left-pad", "version": "1.3.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(rootDepDir, "index.js"), "module.exports = 1;\n", "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "left-pad", "index.js"), "utf8"),
    ).toBe("module.exports = 1;\n");
    expect(fs.existsSync(path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"))).toBe(false);
    expect(fs.existsSync(runtimeDepsStampPath(repoRoot))).toBe(true);
  });

  it("removes legacy runtime dependency stamps from dist", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "left-pad");
    const legacyStampPath = path.join(pluginDir, ".openclaw-runtime-deps-stamp.json");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDepDir, "package.json"),
      '{ "name": "left-pad", "version": "1.3.0" }\n',
      "utf8",
    );
    fs.writeFileSync(legacyStampPath, '{"legacy":true}\n', "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(fs.existsSync(legacyStampPath)).toBe(false);
    expect(fs.existsSync(runtimeDepsStampPath(repoRoot))).toBe(true);
  });

  it("skips missing optional runtime deps when copying the installed closure", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        optionalDependencies: { missingOptional: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0", "optionalDependencies": { "native-extra": "1.0.0" } }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 1;\n", "utf8");

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: () => {
        installCount += 1;
      },
    });

    expect(installCount).toBe(0);
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 1;\n");
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "missingOptional"))).toBe(false);
    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "direct", "node_modules", "native-extra")),
    ).toBe(false);
  });

  it("prunes staged test cargo from copied runtime dependencies", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(path.join(directDir, "test"), { recursive: true });
    fs.mkdirSync(path.join(directDir, "__snapshots__"), { recursive: true });
    fs.mkdirSync(path.join(directDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'runtime';\n", "utf8");
    fs.writeFileSync(
      path.join(directDir, "test", "index.test.js"),
      "module.exports = 'remove';\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(directDir, "__snapshots__", "index.test.ts.snap"),
      "snapshot\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(directDir, "src", "runtime.spec.js"),
      "module.exports = 'remove';\n",
      "utf8",
    );

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'runtime';\n");
    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "direct", "test", "index.test.js")),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(pluginDir, "node_modules", "direct", "__snapshots__", "index.test.ts.snap"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "direct", "src", "runtime.spec.js")),
    ).toBe(false);
  });

  it("preserves nested runtime dependencies named test or tests", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    const nestedTestDir = path.join(directDir, "node_modules", "test");
    const scopedTestsDir = path.join(directDir, "node_modules", "@scope", "tests");
    fs.mkdirSync(nestedTestDir, { recursive: true });
    fs.mkdirSync(scopedTestsDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0", "dependencies": { "test": "^1.0.0", "@scope/tests": "^1.0.0" } }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");
    fs.writeFileSync(
      path.join(nestedTestDir, "package.json"),
      '{ "name": "test", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(nestedTestDir, "index.js"), "module.exports = 'test';\n", "utf8");
    fs.writeFileSync(
      path.join(scopedTestsDir, "package.json"),
      '{ "name": "@scope/tests", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(scopedTestsDir, "index.js"),
      "module.exports = 'scoped-tests';\n",
      "utf8",
    );

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(
        path.join(pluginDir, "node_modules", "direct", "node_modules", "test", "index.js"),
        "utf8",
      ),
    ).toBe("module.exports = 'test';\n");
    expect(
      fs.readFileSync(
        path.join(
          pluginDir,
          "node_modules",
          "direct",
          "node_modules",
          "@scope",
          "tests",
          "index.js",
        ),
        "utf8",
      ),
    ).toBe("module.exports = 'scoped-tests';\n");
  });

  it("stages hoisted transitive runtime deps from the root node_modules", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    const transitiveDir = path.join(repoRoot, "node_modules", "transitive");
    fs.mkdirSync(directDir, { recursive: true });
    fs.mkdirSync(transitiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0", "dependencies": { "transitive": "^1.2.0" } }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");
    fs.writeFileSync(
      path.join(transitiveDir, "package.json"),
      '{ "name": "transitive", "version": "1.2.3" }\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(transitiveDir, "index.js"),
      "module.exports = 'transitive';\n",
      "utf8",
    );

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'direct';\n");
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "transitive", "index.js"), "utf8"),
    ).toBe("module.exports = 'transitive';\n");
  });

  it("stages nested dependency trees from installed direct package roots", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    const nestedDir = path.join(directDir, "node_modules", "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0", "dependencies": { "nested": "^1.0.0" } }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");
    fs.writeFileSync(
      path.join(nestedDir, "package.json"),
      '{ "name": "nested", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(nestedDir, "index.js"), "module.exports = 'nested';\n", "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'direct';\n");
    expect(
      fs.readFileSync(
        path.join(pluginDir, "node_modules", "direct", "node_modules", "nested", "index.js"),
        "utf8",
      ),
    ).toBe("module.exports = 'nested';\n");
  });

  it("falls back to install when a dependency tree contains an unowned symlinked directory", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    const linkedTargetDir = path.join(repoRoot, "linked-target");
    const linkedPath = path.join(directDir, "node_modules", "linked");
    fs.mkdirSync(path.join(directDir, "node_modules"), { recursive: true });
    fs.mkdirSync(linkedTargetDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");
    fs.writeFileSync(path.join(linkedTargetDir, "marker.txt"), "first\n", "utf8");
    fs.symlinkSync(linkedTargetDir, linkedPath);

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "installed\n", "utf8");
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(installCount).toBe(1);
    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "direct", "node_modules", "linked")),
    ).toBe(false);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe(
      "installed\n",
    );
  });

  it("dedupes cyclic dependency aliases by canonical root", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { a: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootNodeModulesDir = path.join(repoRoot, "node_modules");
    const storeDir = path.join(repoRoot, ".store");
    const aStoreDir = path.join(storeDir, "a");
    const bStoreDir = path.join(storeDir, "b");
    fs.mkdirSync(path.join(aStoreDir, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(bStoreDir, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(aStoreDir, "package.json"),
      '{ "name": "a", "version": "1.0.0", "dependencies": { "b": "1.0.0" } }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(aStoreDir, "index.js"), "module.exports = 'a';\n", "utf8");
    fs.writeFileSync(
      path.join(bStoreDir, "package.json"),
      '{ "name": "b", "version": "1.0.0", "dependencies": { "a": "1.0.0" } }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(bStoreDir, "index.js"), "module.exports = 'b';\n", "utf8");
    fs.mkdirSync(rootNodeModulesDir, { recursive: true });
    fs.symlinkSync(aStoreDir, path.join(rootNodeModulesDir, "a"));
    fs.symlinkSync(bStoreDir, path.join(rootNodeModulesDir, "b"));
    fs.symlinkSync(bStoreDir, path.join(aStoreDir, "node_modules", "b"));
    fs.symlinkSync(aStoreDir, path.join(bStoreDir, "node_modules", "a"));

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "a", "index.js"), "utf8")).toBe(
      "module.exports = 'a';\n",
    );
    expect(
      fs.readFileSync(
        path.join(pluginDir, "node_modules", "a", "node_modules", "b", "index.js"),
        "utf8",
      ),
    ).toBe("module.exports = 'b';\n");
  });

  it("falls back to install when a dependency name escapes node_modules", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "../escape": "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "installed\n", "utf8");
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(installCount).toBe(1);
    expect(fs.existsSync(path.join(pluginDir, "escape"))).toBe(false);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe(
      "installed\n",
    );
  });

  it("falls back to install when a staged dependency tree contains a symlink outside copied roots", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    const escapedDir = path.join(repoRoot, "outside-root");
    fs.mkdirSync(path.join(directDir, "node_modules"), { recursive: true });
    fs.mkdirSync(escapedDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");
    fs.writeFileSync(path.join(escapedDir, "secret.txt"), "host secret\n", "utf8");
    fs.symlinkSync(escapedDir, path.join(directDir, "node_modules", "escaped"));

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "installed\n", "utf8");
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(installCount).toBe(1);
    expect(
      fs.existsSync(
        path.join(pluginDir, "node_modules", "direct", "node_modules", "escaped", "secret.txt"),
      ),
    ).toBe(false);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe(
      "installed\n",
    );
  });

  it("falls back to install when the root transitive closure is incomplete", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0", "dependencies": { "missing-transitive": "^1.0.0" } }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules", "direct");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(
          path.join(nodeModulesDir, "package.json"),
          '{ "name": "direct", "version": "1.0.0" }\n',
          "utf8",
        );
        fs.writeFileSync(
          path.join(nodeModulesDir, "index.js"),
          "module.exports = 'installed';\n",
          "utf8",
        );
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(installCount).toBe(1);
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'installed';\n");
  });

  it("removes global non-runtime suffixes from staged runtime dependencies", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 1;\n", "utf8");
    fs.writeFileSync(path.join(directDir, "index.d.ts"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(directDir, "index.js.map"), '{ "version": 3 }\n', "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(fs.existsSync(path.join(pluginDir, "node_modules", "direct", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "direct", "index.d.ts"))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "direct", "index.js.map"))).toBe(
      false,
    );
  });

  it("applies package-specific cargo prune rules after staging", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "rule-target": "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const depDir = path.join(repoRoot, "node_modules", "rule-target");
    fs.mkdirSync(path.join(depDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(depDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(depDir, "package.json"),
      '{ "name": "rule-target", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(depDir, "lib", "index.js"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(depDir, "lib", "index.d.ts"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(depDir, "docs", "guide.md"), "docs\n", "utf8");
    fs.writeFileSync(path.join(depDir, "README.md"), "readme\n", "utf8");
    fs.writeFileSync(path.join(depDir, "LICENSE"), "license\n", "utf8");

    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      stagedRuntimeDepPruneRules: new Map([
        ["rule-target", { paths: ["docs", "README.md"], suffixes: [".d.ts"] }],
      ]),
    });

    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "lib", "index.js")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "lib", "index.d.ts")),
    ).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "docs"))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "README.md"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "LICENSE"))).toBe(
      true,
    );
  });

  it("honors keepDirectories to opt a subtree out of global basename prune", () => {
    // Regression: tokenjuice ships runtime-loaded rule data under
    // `dist/rules/tests/*.json`. Without keepDirectories the global `tests`
    // basename prune would strip that subtree and the plugin would fail to
    // load with `Cannot find module '../rules/tests/bun-test.json'`.
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "keep-target": "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const depDir = path.join(repoRoot, "node_modules", "keep-target");
    fs.mkdirSync(path.join(depDir, "dist", "rules", "tests"), { recursive: true });
    fs.mkdirSync(path.join(depDir, "src", "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(depDir, "package.json"),
      '{ "name": "keep-target", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(depDir, "dist", "rules", "tests", "bun-test.json"),
      '{"rule":"bun"}\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(depDir, "src", "tests", "legit-test.spec.ts"),
      "describe('x', () => {});\n",
      "utf8",
    );

    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      stagedRuntimeDepPruneRules: new Map([
        ["keep-target", { keepDirectories: ["dist/rules/tests"] }],
      ]),
    });

    // Opt-in path: preserved intact.
    expect(
      fs.existsSync(
        path.join(
          pluginDir,
          "node_modules",
          "keep-target",
          "dist",
          "rules",
          "tests",
          "bun-test.json",
        ),
      ),
    ).toBe(true);

    // Unlisted `tests/` directories still get pruned.
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "keep-target", "src", "tests"))).toBe(
      false,
    );
  });

  it("applies default prune rules for known heavy non-runtime package cargo", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: {
          "@cloudflare/workers-types": "1.0.0",
          "@jimp/plugin-blit": "1.0.0",
          gifwrap: "1.0.0",
          "playwright-core": "1.0.0",
        },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootNodeModules = path.join(repoRoot, "node_modules");
    const writePackage = (name: string) => {
      const depDir = path.join(rootNodeModules, ...name.split("/"));
      fs.mkdirSync(depDir, { recursive: true });
      fs.writeFileSync(
        path.join(depDir, "package.json"),
        `${JSON.stringify({ name, version: "1.0.0" }, null, 2)}\n`,
        "utf8",
      );
      return depDir;
    };
    const cloudflareDir = writePackage("@cloudflare/workers-types");
    fs.writeFileSync(path.join(cloudflareDir, "index.d.ts"), "export {};\n", "utf8");
    const gifwrapDir = writePackage("gifwrap");
    fs.mkdirSync(path.join(gifwrapDir, "test", "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(gifwrapDir, "test", "fixtures", "large.gif"), "fixture\n", "utf8");
    const playwrightDir = writePackage("playwright-core");
    fs.mkdirSync(path.join(playwrightDir, "types"), { recursive: true });
    fs.writeFileSync(path.join(playwrightDir, "types", "types.d.ts"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(playwrightDir, "index.js"), "export {};\n", "utf8");
    const jimpDir = writePackage("@jimp/plugin-blit");
    fs.mkdirSync(path.join(jimpDir, "src", "__image_snapshots__"), { recursive: true });
    fs.writeFileSync(
      path.join(jimpDir, "src", "__image_snapshots__", "snapshot.png"),
      "fixture\n",
      "utf8",
    );
    fs.writeFileSync(path.join(jimpDir, "index.js"), "export {};\n", "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "@cloudflare", "workers-types")),
    ).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "gifwrap", "test"))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "playwright-core", "types"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "playwright-core", "index.js"))).toBe(
      true,
    );
    expect(
      fs.existsSync(
        path.join(pluginDir, "node_modules", "@jimp", "plugin-blit", "src", "__image_snapshots__"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "@jimp", "plugin-blit", "index.js")),
    ).toBe(true);
  });

  it("falls back to staging installs when the root dependency version is incompatible", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "^1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "left-pad");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDepDir, "package.json"),
      '{ "name": "left-pad", "version": "2.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(rootDepDir, "index.js"), "module.exports = 'root';\n", "utf8");

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules", "left-pad");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(
          path.join(nodeModulesDir, "package.json"),
          '{ "name": "left-pad", "version": "1.3.0" }\n',
          "utf8",
        );
        fs.writeFileSync(
          path.join(nodeModulesDir, "index.js"),
          "module.exports = 'nested';\n",
          "utf8",
        );
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(installCount).toBe(1);
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "left-pad", "index.js"), "utf8"),
    ).toBe("module.exports = 'nested';\n");
  });

  it("falls back when a ^0.0.x root dependency exceeds the patch ceiling", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { tiny: "^0.0.3" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "tiny");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDepDir, "package.json"),
      '{ "name": "tiny", "version": "0.0.5" }\n',
      "utf8",
    );

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules", "tiny");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(
          path.join(nodeModulesDir, "package.json"),
          '{ "name": "tiny", "version": "0.0.3" }\n',
          "utf8",
        );
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(installCount).toBe(1);
  });

  it("falls back when a stable caret range only matches a prerelease root build", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "^1.2.3" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDepDir, "package.json"),
      '{ "name": "direct", "version": "1.3.0-beta.1" }\n',
      "utf8",
    );

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules", "direct");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(
          path.join(nodeModulesDir, "package.json"),
          '{ "name": "direct", "version": "1.2.3" }\n',
          "utf8",
        );
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(installCount).toBe(1);
  });

  it("retries transient runtime dependency staging failures before surfacing an error", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint, stampPath }: RuntimeDepsStampParams) => {
        installCount += 1;
        if (installCount < 3) {
          throw new Error(`attempt ${installCount} failed`);
        }
        const nodeModulesDir = path.join(pluginDir, "node_modules");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "ok\n", "utf8");
        writeRuntimeDepsStamp(stampPath, fingerprint);
      },
    });

    expect(installCount).toBe(3);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe(
      "ok\n",
    );
  });

  it("surfaces the last staging error after exhausting retries", () => {
    const { repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    expect(() =>
      stageBundledPluginRuntimeDeps({
        cwd: repoRoot,
        installAttempts: 2,
        installPluginRuntimeDepsImpl: () => {
          installCount += 1;
          throw new Error(`attempt ${installCount} failed`);
        },
      }),
    ).toThrow("attempt 2 failed");
    expect(installCount).toBe(2);
  });
});
