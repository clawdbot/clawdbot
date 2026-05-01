import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as bundledRuntimeDepsActivityTesting,
  getActiveBundledRuntimeDepsInstallCount,
  waitForBundledRuntimeDepsInstallIdle,
} from "./bundled-runtime-deps-activity.js";
import {
  installBundledRuntimeDeps,
  installBundledRuntimeDepsAsync,
  repairBundledRuntimeDepsInstallRootAsync,
  type BundledRuntimeDepsInstallParams,
} from "./bundled-runtime-deps-install.js";
import {
  BUNDLED_RUNTIME_DEPS_LOCK_DIR,
  formatRuntimeDepsLockTimeoutMessage,
  shouldRemoveRuntimeDepsLock,
} from "./bundled-runtime-deps-lock.js";
import {
  assertBundledRuntimeDepsInstalled,
  ensureNpmInstallExecutionManifest,
  isRuntimeDepsPlanMaterialized,
} from "./bundled-runtime-deps-materialization.js";
import {
  createBundledRuntimeDepsInstallArgs,
  createBundledRuntimeDepsInstallEnv,
  resolveBundledRuntimeDepsNpmRunner,
  resolveBundledRuntimeDepsPnpmRunner,
} from "./bundled-runtime-deps-package-manager.js";
import {
  isWritableDirectory,
  pruneUnknownBundledRuntimeDepsRoots,
  resolveBundledRuntimeDependencyInstallRoot,
  resolveBundledRuntimeDependencyInstallRootPlan,
  resolveBundledRuntimeDependencyPackageInstallRoot,
} from "./bundled-runtime-deps-roots.js";
import {
  BundledRuntimeDepsMissingError,
  createBundledRuntimeDependencyAliasMap,
  createBundledRuntimeDepsPackagePlan,
  ensureBundledPluginRuntimeDeps,
  repairBundledRuntimeDepsPackagePlanAsync,
} from "./bundled-runtime-deps.js";
import {
  writeBundledPluginRuntimeDepsPackage as writeBundledPluginPackage,
  writeGeneratedRuntimeDepsManifest,
  writeInstalledRuntimeDepPackage as writeInstalledPackage,
} from "./test-helpers/bundled-runtime-deps-fixtures.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);
const spawnSyncMock = vi.mocked(spawnSync);
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-deps-test-"));
  tempDirs.push(dir);
  return dir;
}

function statfsFixture(params: {
  bavail: number;
  bsize?: number;
  blocks?: number;
}): ReturnType<typeof fs.statfsSync> {
  return {
    type: 0,
    bsize: params.bsize ?? 1024,
    blocks: params.blocks ?? 2_000_000,
    bfree: params.bavail,
    bavail: params.bavail,
    files: 0,
    ffree: 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  bundledRuntimeDepsActivityTesting.resetBundledRuntimeDepsInstallActivity();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveBundledRuntimeDepsNpmRunner", () => {
  it("ignores npm_execpath and uses the Node-adjacent npm CLI on Windows", () => {
    const execPath = "C:\\Program Files\\nodejs\\node.exe";
    const npmCliPath = path.win32.resolve(
      path.win32.dirname(execPath),
      "node_modules/npm/bin/npm-cli.js",
    );
    const runner = resolveBundledRuntimeDepsNpmRunner({
      env: { npm_execpath: "C:\\repo\\evil\\npm-cli.js" },
      execPath,
      existsSync: (candidate) =>
        candidate === "C:\\repo\\evil\\npm-cli.js" || candidate === npmCliPath,
      npmArgs: ["install", "acpx@0.5.3"],
      platform: "win32",
    });

    expect(runner).toEqual({
      command: execPath,
      args: [npmCliPath, "install", "acpx@0.5.3"],
    });
  });

  it("uses package-manager-neutral install args with npm config env", () => {
    expect(createBundledRuntimeDepsInstallArgs()).toEqual([
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--workspaces=false",
      "--no-audit",
      "--no-fund",
    ]);
    expect(
      createBundledRuntimeDepsInstallEnv(
        {
          PATH: "/usr/bin:/bin",
          NPM_CONFIG_CACHE: "/Users/alice/.npm-uppercase",
          NPM_CONFIG_GLOBAL: "true",
          NPM_CONFIG_IGNORE_SCRIPTS: "false",
          NPM_CONFIG_LOCATION: "global",
          NPM_CONFIG_PREFIX: "/Users/alice",
          npm_config_cache: "/Users/alice/.npm",
          npm_config_dry_run: "true",
          npm_config_global: "true",
          npm_config_include_workspace_root: "true",
          npm_config_ignore_scripts: "false",
          npm_config_location: "global",
          npm_config_prefix: "/opt/homebrew",
          npm_config_workspace: "extensions/telegram",
          npm_config_workspaces: "true",
          npm_execpath: "/repo/evil/npm-cli.js",
          NPM_EXECPATH: "/repo/evil-uppercase/npm-cli.js",
        },
        { cacheDir: "/opt/openclaw/runtime-cache" },
      ),
    ).toEqual({
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      PATH: "/usr/bin:/bin",
      npm_config_audit: "false",
      npm_config_cache: "/opt/openclaw/runtime-cache",
      npm_config_dry_run: "false",
      npm_config_fetch_retries: "5",
      npm_config_fetch_retry_maxtimeout: "120000",
      npm_config_fetch_retry_mintimeout: "10000",
      npm_config_fetch_timeout: "300000",
      npm_config_fund: "false",
      npm_config_global: "false",
      npm_config_ignore_scripts: "true",
      npm_config_legacy_peer_deps: "true",
      npm_config_location: "project",
      npm_config_package_lock: "true",
      npm_config_save: "false",
      npm_config_workspaces: "false",
    });
  });

  it("uses the Node-adjacent npm CLI on Windows", () => {
    const execPath = "C:\\Program Files\\nodejs\\node.exe";
    const npmCliPath = path.win32.resolve(
      path.win32.dirname(execPath),
      "node_modules/npm/bin/npm-cli.js",
    );

    const runner = resolveBundledRuntimeDepsNpmRunner({
      env: {},
      execPath,
      existsSync: (candidate) => candidate === npmCliPath,
      npmArgs: ["install", "acpx@0.5.3"],
      platform: "win32",
    });

    expect(runner).toEqual({
      command: execPath,
      args: [npmCliPath, "install", "acpx@0.5.3"],
    });
  });

  it("ignores npm_execpath and falls back to Node-adjacent npm", () => {
    const execPath = "/opt/node/bin/node";
    const npmCliPath = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
    const runner = resolveBundledRuntimeDepsNpmRunner({
      env: {
        npm_execpath: "/home/runner/repo/evil/npm-cli.js",
      },
      execPath,
      existsSync: (candidate) =>
        candidate === "/home/runner/repo/evil/npm-cli.js" || candidate === npmCliPath,
      npmArgs: ["install", "acpx@0.5.3"],
      platform: "linux",
    });

    expect(runner).toEqual({
      command: execPath,
      args: [npmCliPath, "install", "acpx@0.5.3"],
    });
  });

  it("uses the Node-adjacent POSIX npm shim when npm-cli.js is unavailable", () => {
    const execPath = "/opt/node/bin/node";
    const npmPath = "/opt/node/bin/npm";
    const runner = resolveBundledRuntimeDepsNpmRunner({
      env: {},
      execPath,
      existsSync: (candidate) => candidate === npmPath,
      npmArgs: ["install", "acpx@0.5.3"],
      platform: "linux",
    });

    expect(runner).toEqual({
      command: npmPath,
      args: ["install", "acpx@0.5.3"],
    });
  });

  it("refuses Windows shell fallback when no safe npm executable is available", () => {
    expect(() =>
      resolveBundledRuntimeDepsNpmRunner({
        env: {},
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        existsSync: () => false,
        npmArgs: ["install"],
        platform: "win32",
      }),
    ).toThrow("Unable to resolve a safe npm executable on Windows");
  });

  it("ignores Windows pnpm.cmd shims for shell-free installs", () => {
    const execPath = "C:\\Program Files\\nodejs\\node.exe";
    const pnpmCmdPath = "C:\\Program Files\\nodejs\\pnpm.cmd";

    expect(
      resolveBundledRuntimeDepsPnpmRunner({
        env: {},
        execPath,
        existsSync: (candidate) => candidate === pnpmCmdPath,
        platform: "win32",
        pnpmArgs: ["install"],
      }),
    ).toBeNull();
  });

  it("uses Windows pnpm.exe when available for shell-free installs", () => {
    const execPath = "C:\\Program Files\\nodejs\\node.exe";
    const pnpmExePath = "C:\\Program Files\\nodejs\\pnpm.exe";

    expect(
      resolveBundledRuntimeDepsPnpmRunner({
        env: {},
        execPath,
        existsSync: (candidate) => candidate === pnpmExePath,
        platform: "win32",
        pnpmArgs: ["install"],
      }),
    ).toEqual({
      packageManager: "pnpm",
      command: pnpmExePath,
      args: ["install"],
    });
  });

  it("refuses POSIX npm shim fallback when npm-cli.js is unavailable", () => {
    expect(() =>
      resolveBundledRuntimeDepsNpmRunner({
        env: {
          PATH: "/repo/evil/bin:/usr/bin:/bin",
        },
        execPath: "/opt/node/bin/node",
        existsSync: (candidate) => candidate === "/usr/bin/npm",
        npmArgs: ["install"],
        platform: "linux",
      }),
    ).toThrow("Unable to resolve a safe npm executable");
  });
});

describe("installBundledRuntimeDeps", () => {
  it("uses a real write probe for runtime dependency roots", () => {
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
      const error = new Error("read-only file system") as NodeJS.ErrnoException;
      error.code = "EROFS";
      throw error;
    });

    expect(isWritableDirectory("/usr/lib/node_modules/openclaw")).toBe(false);
    expect(accessSpy).not.toHaveBeenCalled();
    expect(mkdirSpy).toHaveBeenCalledWith(
      path.join("/usr/lib/node_modules/openclaw", ".openclaw-write-probe-"),
    );
  });

  it("ignores npm_execpath during Windows installs", () => {
    const installRoot = makeTempDir();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const safeNpmCliPath = path.win32.resolve(
      path.win32.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    );
    const attackerNpmCliPath = "C:\\repo\\evil\\npm-cli.js";
    const realExistsSync = fs.existsSync.bind(fs);
    vi.spyOn(fs, "existsSync").mockImplementation(
      (candidate) =>
        candidate === attackerNpmCliPath ||
        candidate === safeNpmCliPath ||
        realExistsSync(candidate),
    );
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      writeInstalledPackage(String(options?.cwd ?? ""), "acpx", "0.5.3");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    installBundledRuntimeDeps({
      installRoot,
      missingSpecs: ["acpx@0.5.3"],
      env: {
        npm_config_prefix: "C:\\prefix",
        PATH: "C:\\node",
        npm_execpath: attackerNpmCliPath,
      },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      [
        safeNpmCliPath,
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--workspaces=false",
        "--no-audit",
        "--no-fund",
      ],
      expect.objectContaining({
        cwd: installRoot,
        windowsHide: true,
        env: expect.objectContaining({
          npm_config_dry_run: "false",
          npm_config_ignore_scripts: "true",
          npm_config_legacy_peer_deps: "true",
          npm_config_package_lock: "true",
          npm_config_save: "false",
          npm_config_workspaces: "false",
        }),
      }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({
          npm_config_prefix: expect.any(String),
        }),
      }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({
          npm_execpath: expect.any(String),
        }),
      }),
    );
  });

  it("isolates pnpm installs from an enclosing workspace", () => {
    const parentRoot = makeTempDir();
    const installRoot = path.join(parentRoot, "repo", "dist-runtime", "extensions", "qa-lab");
    const pnpmBinDir = path.join(parentRoot, "bin");
    fs.mkdirSync(pnpmBinDir, { recursive: true });
    fs.writeFileSync(path.join(pnpmBinDir, "pnpm"), "#!/bin/sh\n", "utf8");
    fs.mkdirSync(path.join(parentRoot, "repo"), { recursive: true });
    fs.writeFileSync(
      path.join(parentRoot, "repo", "pnpm-workspace.yaml"),
      "packages: []\n",
      "utf8",
    );
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      writeInstalledPackage(String(options?.cwd ?? ""), "zod", "4.3.6");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    installBundledRuntimeDeps({
      installRoot,
      missingSpecs: ["zod@4.3.6"],
      env: {
        PATH: pnpmBinDir,
      },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("pnpm"),
      expect.arrayContaining(["install", "--ignore-workspace", "--config.minimum-release-age=0"]),
      expect.objectContaining({
        cwd: installRoot,
      }),
    );
  });

  it("removes reused node_modules symlinks before package-manager repair", () => {
    const parentRoot = makeTempDir();
    const sourceRoot = path.join(parentRoot, "openclaw-2026.4.28-source");
    const installRoot = path.join(parentRoot, "openclaw-2026.4.29-target");
    fs.mkdirSync(installRoot, { recursive: true });
    writeInstalledPackage(sourceRoot, "alpha-runtime", "1.0.0");
    fs.symlinkSync(
      path.join(sourceRoot, "node_modules"),
      path.join(installRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      writeInstalledPackage(String(options?.cwd ?? ""), "beta-runtime", "2.0.0");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    installBundledRuntimeDeps({
      installRoot,
      missingSpecs: ["beta-runtime@2.0.0"],
      env: {},
    });

    expect(
      fs.existsSync(path.join(sourceRoot, "node_modules", "beta-runtime", "package.json")),
    ).toBe(false);
    expect(fs.lstatSync(path.join(installRoot, "node_modules")).isSymbolicLink()).toBe(false);
    expect(
      fs.existsSync(path.join(installRoot, "node_modules", "beta-runtime", "package.json")),
    ).toBe(true);
  });

  it("hides async npm child windows for startup repair installs", async () => {
    const installRoot = makeTempDir();
    spawnMock.mockImplementation((_command, _args, options) => {
      writeInstalledPackage(String(options?.cwd ?? ""), "acpx", "0.5.3");
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await repairBundledRuntimeDepsInstallRootAsync({
      installRoot,
      missingSpecs: ["acpx@0.5.3"],
      installSpecs: ["acpx@0.5.3"],
      env: {},
    });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        cwd: installRoot,
        windowsHide: true,
      }),
    );
  });

  it("reruns async repair when the generated manifest was missing from an existing tree", async () => {
    const installRoot = makeTempDir();
    writeInstalledPackage(installRoot, "acpx", "0.5.3");
    spawnMock.mockImplementation((_command, _args, options) => {
      writeInstalledPackage(String(options?.cwd ?? ""), "acpx", "0.5.3");
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await repairBundledRuntimeDepsInstallRootAsync({
      installRoot,
      missingSpecs: ["acpx@0.5.3"],
      installSpecs: ["acpx@0.5.3"],
      env: {},
    });

    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("reports async package-manager output as install progress", async () => {
    const installRoot = makeTempDir();
    const progress: string[] = [];
    spawnMock.mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd ?? "");
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => {
        child.stdout?.emit("data", Buffer.from("added 1 package\n"));
        child.stderr?.emit("data", Buffer.from("\u001b[31mnpm notice\u001b[39m\r"));
        writeInstalledPackage(cwd, "acpx", "0.5.3");
        child.emit("close", 0, null);
      });
      return child;
    });

    await installBundledRuntimeDepsAsync({
      installRoot,
      missingSpecs: ["acpx@0.5.3"],
      env: {},
      onProgress: (message) => progress.push(message),
    });

    expect(progress).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^Starting (npm|pnpm) install for bundled plugin runtime deps: acpx@0\.5\.3$/,
        ),
        expect.stringMatching(/^(npm|pnpm) stdout: added 1 package$/),
        expect.stringMatching(/^(npm|pnpm) stderr: npm notice$/),
      ]),
    );
  });

  it("emits heartbeat progress while async package-manager install is silent", async () => {
    vi.useFakeTimers();
    try {
      const installRoot = makeTempDir();
      const progress: string[] = [];
      let closeChild!: () => void;
      spawnMock.mockImplementation((_command, _args, options) => {
        const cwd = String(options?.cwd ?? "");
        const child = new EventEmitter() as ReturnType<typeof spawn>;
        Object.assign(child, {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        closeChild = () => {
          writeInstalledPackage(cwd, "acpx", "0.5.3");
          child.emit("close", 0, null);
        };
        return child;
      });

      const install = installBundledRuntimeDepsAsync({
        installRoot,
        missingSpecs: ["acpx@0.5.3"],
        env: {},
        onProgress: (message) => progress.push(message),
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(progress).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^(npm|pnpm) install still running \(5s elapsed\)$/),
        ]),
      );

      closeChild();
      await expect(install).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors non-isolated external install roots with a package manifest", () => {
    const parentRoot = makeTempDir();
    const installRoot = path.join(parentRoot, ".openclaw", "plugin-runtime-deps", "openclaw-test");
    fs.mkdirSync(path.join(parentRoot, "node_modules", "@grammyjs"), { recursive: true });
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd ?? "");
      expect(cwd).toBe(installRoot);
      expect(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))).toEqual({
        name: "openclaw-runtime-deps-install",
        private: true,
        dependencies: {
          "@grammyjs/runner": "^2.0.3",
          grammy: "1.37.0",
        },
      });
      writeInstalledPackage(cwd, "@grammyjs/runner", "2.0.3");
      writeInstalledPackage(cwd, "grammy", "1.37.0");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    installBundledRuntimeDeps({
      installRoot,
      missingSpecs: ["@grammyjs/runner@^2.0.3"],
      installSpecs: ["@grammyjs/runner@^2.0.3", "grammy@1.37.0"],
      env: {
        HOME: parentRoot,
      },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.arrayContaining(["grammy@1.37.0"]),
      expect.objectContaining({
        cwd: installRoot,
      }),
    );
  });

  it("always includes a dependencies field in the install manifest, even when specs are empty", () => {
    const installRoot = makeTempDir();

    ensureNpmInstallExecutionManifest(installRoot, []);

    const written = JSON.parse(fs.readFileSync(path.join(installRoot, "package.json"), "utf8")) as {
      dependencies?: unknown;
    };
    expect(written).toHaveProperty("dependencies");
    expect(written.dependencies).toEqual({});
  });

  it("repairs external install roots from the complete generated dependency plan", async () => {
    const installRoot = makeTempDir();
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    spawnMock.mockImplementation((_command, args, options) => {
      const cwd = String(options?.cwd ?? "");
      expect(args).toEqual(expect.arrayContaining(["install", "--ignore-scripts"]));
      expect(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))).toEqual({
        name: "openclaw-runtime-deps-install",
        private: true,
        dependencies: {
          "alpha-runtime": "1.0.0",
          "beta-runtime": "2.0.0",
        },
      });
      writeInstalledPackage(cwd, "beta-runtime", "2.0.0");
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await repairBundledRuntimeDepsInstallRootAsync({
      installRoot,
      missingSpecs: ["beta-runtime@2.0.0"],
      installSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
      env: {},
    });

    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("writes the requested package-manager install plan during startup repair", async () => {
    const installRoot = makeTempDir();
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);
    spawnMock.mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd ?? "");
      expect(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))).toEqual({
        name: "openclaw-runtime-deps-install",
        private: true,
        dependencies: {
          "beta-runtime": "2.0.0",
        },
      });
      writeInstalledPackage(cwd, "beta-runtime", "2.0.0");
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await repairBundledRuntimeDepsInstallRootAsync({
      installRoot,
      missingSpecs: ["beta-runtime@2.0.0"],
      installSpecs: ["beta-runtime@2.0.0"],
      env: {},
    });

    expect(JSON.parse(fs.readFileSync(path.join(installRoot, "package.json"), "utf8"))).toEqual({
      name: "openclaw-runtime-deps-install",
      private: true,
      dependencies: {
        "beta-runtime": "2.0.0",
      },
    });
  });

  it("lets the package manager prune stale deps during package-level repair", async () => {
    const installRoot = makeTempDir();
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    fs.writeFileSync(
      path.join(installRoot, ".openclaw-runtime-deps.json"),
      `${JSON.stringify({ specs: ["alpha-runtime@1.0.0"] }, null, 2)}\n`,
      "utf8",
    );
    spawnMock.mockImplementation((_command, _args, options) => {
      fs.rmSync(path.join(installRoot, "node_modules", "alpha-runtime"), {
        recursive: true,
        force: true,
      });
      writeInstalledPackage(String(options?.cwd ?? ""), "beta-runtime", "2.0.0");
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    await repairBundledRuntimeDepsInstallRootAsync({
      installRoot,
      missingSpecs: ["beta-runtime@2.0.0"],
      installSpecs: ["beta-runtime@2.0.0"],
      env: {},
    });

    expect(
      fs.existsSync(path.join(installRoot, "node_modules", "alpha-runtime", "package.json")),
    ).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(installRoot, "package.json"), "utf8"))).toEqual({
      name: "openclaw-runtime-deps-install",
      private: true,
      dependencies: {
        "beta-runtime": "2.0.0",
      },
    });
    expect(fs.existsSync(path.join(installRoot, ".openclaw-runtime-deps.json"))).toBe(false);
  });

  it("warns but still installs bundled runtime deps when disk space looks low", () => {
    const installRoot = makeTempDir();
    const warn = vi.fn();
    vi.spyOn(fs, "statfsSync").mockReturnValue(
      statfsFixture({
        bavail: 256,
        bsize: 1024 * 1024,
      }),
    );
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      writeInstalledPackage(String(options?.cwd ?? ""), "acpx", "0.5.3");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    installBundledRuntimeDeps({
      installRoot,
      missingSpecs: ["acpx@0.5.3"],
      env: {},
      warn,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Low disk space near"));
    expect(spawnSyncMock).toHaveBeenCalled();
    expect(fs.existsSync(path.join(installRoot, "node_modules", "acpx", "package.json"))).toBe(
      true,
    );
  });

  it("uses an isolated execution root and copies node_modules back when requested", () => {
    const installRoot = makeTempDir();
    const installExecutionRoot = makeTempDir();
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd ?? "");
      writeInstalledPackage(cwd, "tokenjuice", "0.6.1");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    installBundledRuntimeDeps({
      installRoot,
      installExecutionRoot,
      missingSpecs: ["tokenjuice@0.6.1"],
      env: {},
    });

    expect(
      JSON.parse(fs.readFileSync(path.join(installExecutionRoot, "package.json"), "utf8")),
    ).toEqual({
      name: "openclaw-runtime-deps-install",
      private: true,
      dependencies: {
        tokenjuice: "0.6.1",
      },
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(installRoot, "node_modules", "tokenjuice", "package.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      name: "tokenjuice",
      version: "0.6.1",
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        cwd: installExecutionRoot,
      }),
    );
  });

  it("installs the full generated plan when plugin-root staging replaces node_modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "alpha-runtime": "1.0.0",
          "beta-runtime": "2.0.0",
        },
      }),
    );
    writeInstalledPackage(pluginRoot, "alpha-runtime", "1.0.0");
    spawnSyncMock.mockImplementation((_command, args, options) => {
      const cwd = String(options?.cwd ?? "");
      expect(cwd).toBe(path.join(pluginRoot, ".openclaw-install-stage"));
      expect(args).toEqual(expect.arrayContaining(["install", "--ignore-scripts"]));
      writeInstalledPackage(cwd, "alpha-runtime", "1.0.0");
      writeInstalledPackage(cwd, "beta-runtime", "2.0.0");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    expect(
      ensureBundledPluginRuntimeDeps({
        env: {},
        pluginId: "local-plugin",
        pluginRoot,
      }),
    ).toEqual({
      installedSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
    });
    expect(spawnSyncMock).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(pluginRoot, "node_modules", "alpha-runtime", "package.json"),
          "utf8",
        ),
      ),
    ).toEqual({ name: "alpha-runtime", version: "1.0.0" });
  });

  it("uses an OpenClaw-owned npm cache for runtime dependency installs", () => {
    const installRoot = makeTempDir();
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      writeInstalledPackage(String(options?.cwd ?? ""), "tokenjuice", "0.6.1");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    installBundledRuntimeDeps({
      installRoot,
      missingSpecs: ["tokenjuice@0.6.1"],
      env: {
        HOME: "/Users/alice",
        NPM_CONFIG_CACHE: "/Users/alice/.npm-uppercase",
        NPM_CONFIG_GLOBAL: "true",
        NPM_CONFIG_LOCATION: "global",
        NPM_CONFIG_PREFIX: "/Users/alice",
        npm_config_cache: "/Users/alice/.npm",
        npm_config_global: "true",
        npm_config_location: "global",
        npm_config_prefix: "/opt/homebrew",
      },
    });

    expect(JSON.parse(fs.readFileSync(path.join(installRoot, "package.json"), "utf8"))).toEqual({
      name: "openclaw-runtime-deps-install",
      private: true,
      dependencies: {
        tokenjuice: "0.6.1",
      },
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        cwd: installRoot,
        env: expect.objectContaining({
          HOME: "/Users/alice",
          npm_config_cache: path.join(installRoot, ".openclaw-npm-cache"),
        }),
      }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({
          NPM_CONFIG_CACHE: expect.any(String),
          NPM_CONFIG_GLOBAL: expect.any(String),
          NPM_CONFIG_LOCATION: expect.any(String),
          NPM_CONFIG_PREFIX: expect.any(String),
          npm_config_global: expect.any(String),
          npm_config_location: expect.any(String),
          npm_config_prefix: expect.any(String),
        }),
      }),
    );
  });

  it("fails when npm exits cleanly without installing requested packages", () => {
    const installRoot = makeTempDir();
    spawnSyncMock.mockReturnValue({
      pid: 123,
      output: [],
      stdout: "",
      stderr: "",
      signal: null,
      status: 0,
    });

    expect(() =>
      installBundledRuntimeDeps({
        installRoot,
        missingSpecs: ["tokenjuice@0.6.1"],
        env: {},
      }),
    ).toThrow(
      `package manager install did not place bundled runtime deps in ${installRoot}: tokenjuice@0.6.1`,
    );
  });

  it("accepts package-manager-installed deps without revalidating entry files", () => {
    const installRoot = makeTempDir();
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      const packageDir = path.join(String(options?.cwd ?? ""), "node_modules", "jszip");
      fs.mkdirSync(path.join(packageDir, "lib"), { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "jszip", version: "3.10.1", main: "./lib/index" }),
      );
      fs.writeFileSync(path.join(packageDir, "lib", "index.js"), "export default {};\n");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    installBundledRuntimeDeps({
      installRoot,
      missingSpecs: ["jszip@^3.10.1"],
      env: {},
    });
  });

  it("cleans an owned isolated execution root after copying node_modules back", () => {
    const installRoot = makeTempDir();
    const installExecutionRoot = path.join(installRoot, ".openclaw-install-stage");
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd ?? "");
      writeInstalledPackage(cwd, "tokenjuice", "0.6.1");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    installBundledRuntimeDeps({
      installRoot,
      installExecutionRoot,
      missingSpecs: ["tokenjuice@0.6.1"],
      env: {},
    });

    expect(fs.existsSync(installExecutionRoot)).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(installRoot, "node_modules", "tokenjuice", "package.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      name: "tokenjuice",
      version: "0.6.1",
    });
  });

  it("does not fail an isolated runtime deps install when temp cleanup races", () => {
    const installRoot = makeTempDir();
    const installExecutionRoot = makeTempDir();
    const realRmSync = fs.rmSync.bind(fs);
    let blockedCleanup = false;
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (
        !blockedCleanup &&
        path.basename(String(target)).startsWith(".openclaw-runtime-deps-copy-")
      ) {
        blockedCleanup = true;
        const error = new Error("Directory not empty") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      return realRmSync(target, options);
    });
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd ?? "");
      writeInstalledPackage(cwd, "tokenjuice", "0.6.1");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    expect(() =>
      installBundledRuntimeDeps({
        installRoot,
        installExecutionRoot,
        missingSpecs: ["tokenjuice@0.6.1"],
        env: {},
      }),
    ).not.toThrow();

    expect(blockedCleanup).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(installRoot, "node_modules", "tokenjuice", "package.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      name: "tokenjuice",
      version: "0.6.1",
    });
  });

  it("rejects invalid install specs before spawning npm", () => {
    expect(() =>
      installBundledRuntimeDeps({
        installRoot: makeTempDir(),
        missingSpecs: ["tokenjuice@https://evil.example/t.tgz"],
        env: {},
      }),
    ).toThrow("Unsupported bundled runtime dependency spec for tokenjuice");
  });

  it("includes spawn errors in install failures", () => {
    spawnSyncMock.mockReturnValue({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      signal: null,
      status: null,
      error: new Error("spawn npm ENOENT"),
    });

    expect(() =>
      installBundledRuntimeDeps({
        installRoot: "/tmp/openclaw",
        missingSpecs: ["browser-runtime@1.0.0"],
        env: {},
      }),
    ).toThrow("spawn npm ENOENT");
  });
});

describe("createBundledRuntimeDepsPackagePlan config policy", () => {
  type RuntimeDepsConfigCase = {
    name: string;
    config: Parameters<typeof createBundledRuntimeDepsPackagePlan>[0]["config"];
    includeConfiguredChannels: boolean;
    includeEnabledByDefaultPlugins?: boolean;
    expectedDeps: string[];
  };

  function setupPolicyPackageRoot(): string {
    const packageRoot = makeTempDir();
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "alpha",
      deps: { "alpha-runtime": "1.0.0" },
      enabledByDefault: true,
    });
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "telegram",
      deps: { "telegram-runtime": "2.0.0" },
      channels: ["telegram"],
    });
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "amazon-bedrock",
      deps: { "bedrock-runtime": "3.0.0" },
      enabledByDefault: true,
      providers: ["amazon-bedrock"],
    });
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "anthropic",
      deps: { "anthropic-runtime": "4.0.0" },
      modelSupport: { modelPrefixes: ["claude-"] },
      providers: ["anthropic"],
    });
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "openai",
      deps: { "openai-runtime": "5.0.0" },
      modelSupport: { modelPrefixes: ["gpt-", "o1", "o3", "o4"] },
      providers: ["openai", "openai-codex"],
    });
    return packageRoot;
  }

  const cases: RuntimeDepsConfigCase[] = [
    {
      name: "includes default-enabled bundled plugins",
      config: {},
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0"],
    },
    {
      name: "keeps default-enabled bundled plugins behind restrictive allowlists",
      config: { plugins: { allow: ["browser"] } },
      includeConfiguredChannels: false,
      expectedDeps: [],
    },
    {
      name: "includes selected memory slot bundled plugins behind restrictive allowlists",
      config: { plugins: { allow: ["browser"], slots: { memory: "alpha" } } },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0"],
    },
    {
      name: "does not let explicit plugin entries bypass restrictive allowlists",
      config: { plugins: { allow: ["browser"], entries: { alpha: { enabled: true } } } },
      includeConfiguredChannels: false,
      expectedDeps: [],
    },
    {
      name: "lets deny override default-enabled bundled plugins",
      config: { plugins: { deny: ["alpha"] } },
      includeConfiguredChannels: false,
      expectedDeps: [],
    },
    {
      name: "lets disabled entries override default-enabled bundled plugins",
      config: { plugins: { entries: { alpha: { enabled: false } } } },
      includeConfiguredChannels: false,
      expectedDeps: [],
    },
    {
      name: "lets plugin deny override explicit bundled channel enablement",
      config: {
        plugins: { deny: ["telegram"] },
        channels: { telegram: { enabled: true } },
      },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0"],
    },
    {
      name: "lets the plugin master toggle suppress explicit bundled channel enablement",
      config: {
        plugins: { enabled: false },
        channels: { telegram: { enabled: true } },
      },
      includeConfiguredChannels: false,
      expectedDeps: [],
    },
    {
      name: "lets plugin entry disablement override explicit bundled channel enablement",
      config: {
        plugins: { entries: { telegram: { enabled: false } } },
        channels: { telegram: { enabled: true } },
      },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0"],
    },
    {
      name: "lets explicit bundled channel enablement bypass restrictive allowlists",
      config: {
        plugins: { allow: ["browser"] },
        channels: { telegram: { enabled: true } },
      },
      includeConfiguredChannels: false,
      expectedDeps: ["telegram-runtime@2.0.0"],
    },
    {
      name: "keeps channel recovery behind restrictive allowlists",
      config: {
        plugins: { allow: ["browser"] },
        channels: { telegram: { botToken: "123:abc" } },
      },
      includeConfiguredChannels: true,
      expectedDeps: [],
    },
    {
      name: "includes configured channels during recovery without restrictive allowlists",
      config: { channels: { telegram: { botToken: "123:abc" } } },
      includeConfiguredChannels: true,
      expectedDeps: ["alpha-runtime@1.0.0", "telegram-runtime@2.0.0"],
    },
    {
      name: "lets explicit channel disable override recovery",
      config: { channels: { telegram: { botToken: "123:abc", enabled: false } } },
      includeConfiguredChannels: true,
      expectedDeps: ["alpha-runtime@1.0.0"],
    },
    {
      name: "includes configured model provider deps",
      config: { agents: { defaults: { model: "amazon-bedrock/claude-opus-4-7" } } },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0", "bedrock-runtime@3.0.0"],
    },
    {
      name: "includes configured bare model owner deps from model support",
      config: { agents: { defaults: { model: "gpt-5.5" } } },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0", "openai-runtime@5.0.0"],
    },
    {
      name: "includes configured bare fallback model owner deps from model support",
      config: {
        agents: {
          defaults: { model: { primary: "unknown-model", fallbacks: ["claude-sonnet-4-6"] } },
        },
      },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0", "anthropic-runtime@4.0.0"],
    },
    {
      name: "includes configured model provider deps from manifest provider aliases",
      config: { agents: { defaults: { model: "openai-codex/gpt-5.5" } } },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0", "openai-runtime@5.0.0"],
    },
    {
      name: "includes configured model provider deps from aliases",
      config: { models: { providers: { "aws-bedrock": { baseUrl: "", models: [] } } } },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0", "bedrock-runtime@3.0.0"],
    },
    {
      name: "includes configured subagent model provider deps",
      config: { agents: { defaults: { subagents: { model: "bedrock/claude-sonnet-4-6" } } } },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0", "bedrock-runtime@3.0.0"],
    },
    {
      name: "keeps configured provider deps behind restrictive allowlists",
      config: {
        plugins: { allow: ["alpha"] },
        agents: { defaults: { model: "amazon-bedrock/claude-opus-4-7" } },
      },
      includeConfiguredChannels: false,
      expectedDeps: ["alpha-runtime@1.0.0"],
    },
    {
      name: "can omit default-enabled bundled plugins for post-config repair",
      config: {},
      includeConfiguredChannels: true,
      includeEnabledByDefaultPlugins: false,
      expectedDeps: [],
    },
    {
      name: "includes configured channels when default-enabled plugins are omitted",
      config: { channels: { telegram: { botToken: "123:abc" } } },
      includeConfiguredChannels: true,
      includeEnabledByDefaultPlugins: false,
      expectedDeps: ["telegram-runtime@2.0.0"],
    },
    {
      name: "includes configured provider deps when default-enabled plugins are omitted",
      config: { agents: { defaults: { model: "amazon-bedrock/claude-opus-4-7" } } },
      includeConfiguredChannels: false,
      includeEnabledByDefaultPlugins: false,
      expectedDeps: ["bedrock-runtime@3.0.0"],
    },
  ];

  it.each(cases)(
    "$name",
    ({ config, includeConfiguredChannels, includeEnabledByDefaultPlugins, expectedDeps }) => {
      const result = createBundledRuntimeDepsPackagePlan({
        packageRoot: setupPolicyPackageRoot(),
        config,
        includeConfiguredChannels,
        ...(includeEnabledByDefaultPlugins !== undefined ? { includeEnabledByDefaultPlugins } : {}),
      });

      expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual(expectedDeps);
      expect(result.conflicts).toEqual([]);
    },
  );

  it("honors deny and disabled entries when scanning an explicit effective plugin set", () => {
    const packageRoot = setupPolicyPackageRoot();

    const denied = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      pluginIds: ["telegram"],
      config: {
        plugins: { deny: ["telegram"] },
        channels: { telegram: { enabled: true } },
      },
    });
    const disabled = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      pluginIds: ["telegram"],
      config: {
        plugins: { entries: { telegram: { enabled: false } } },
        channels: { telegram: { enabled: true } },
      },
    });
    const allowed = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      pluginIds: ["telegram"],
      config: {
        plugins: { entries: { telegram: { enabled: true } } },
        channels: { telegram: { enabled: true } },
      },
    });

    expect(denied.deps).toEqual([]);
    expect(disabled.deps).toEqual([]);
    expect(allowed.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "telegram-runtime@2.0.0",
    ]);
  });

  it("trusts preselected startup plugin ids without reapplying config policy", () => {
    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot: setupPolicyPackageRoot(),
      exactPluginIds: ["telegram"],
      config: {
        plugins: { allow: ["browser"] },
        channels: { telegram: { botToken: "123:abc" } },
      },
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "telegram-runtime@2.0.0",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not stage explicitly disabled preselected channel deps", () => {
    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot: setupPolicyPackageRoot(),
      exactPluginIds: ["telegram"],
      config: {
        plugins: { allow: ["telegram"] },
        channels: { telegram: { enabled: false, botToken: "123:abc" } },
      },
    });

    expect(result.deps).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not report already staged package-level runtime deps as missing", () => {
    const packageRoot = setupPolicyPackageRoot();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: makeTempDir() };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env,
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["alpha-runtime@1.0.0"]);
    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("accepts staged runtime deps with extensionless declared entry files", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "jszip");
    fs.mkdirSync(path.join(packageDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "jszip", version: "3.10.1", main: "./lib/index" }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "lib", "index.js"), "export default {};\n", "utf8");

    expect(() => assertBundledRuntimeDepsInstalled(installRoot, ["jszip@^3.10.1"])).not.toThrow();
  });

  it("accepts staged runtime deps that rely on the default package entry", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "alpha-runtime", version: "1.0.0" }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "index.js"), "export {};\n", "utf8");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(true);
    expect(() =>
      assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"]),
    ).not.toThrow();
  });

  it("accepts staged runtime deps that expose a package bin entry", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "@zed-industries", "codex-acp");
    fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@zed-industries/codex-acp",
        version: "0.12.0",
        bin: {
          "codex-acp": "bin/codex-acp.js",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "bin", "codex-acp.js"), "#!/usr/bin/env node\n");
    writeGeneratedRuntimeDepsManifest(installRoot, ["@zed-industries/codex-acp@0.12.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["@zed-industries/codex-acp@0.12.0"])).toBe(
      true,
    );
    expect(() =>
      assertBundledRuntimeDepsInstalled(installRoot, ["@zed-industries/codex-acp@0.12.0"]),
    ).not.toThrow();
  });

  it("accepts staged runtime deps with exported package entry files", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "alpha-runtime",
        version: "1.0.0",
        exports: {
          ".": {
            import: "./dist/index.mjs",
            require: "./dist/index.cjs",
          },
          "./package.json": "./package.json",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "dist", "index.mjs"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(packageDir, "dist", "index.cjs"), "module.exports = {};\n", "utf8");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(true);
    expect(() =>
      assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"]),
    ).not.toThrow();
  });

  it("accepts staged runtime deps when a usable export subpath is present", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(path.join(packageDir, "dist", "esm", "client"), { recursive: true });
    fs.mkdirSync(path.join(packageDir, "dist", "cjs", "client"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "alpha-runtime",
        version: "1.0.0",
        exports: {
          ".": {
            types: "./dist/esm/index.d.ts",
            import: "./dist/esm/index.js",
            require: "./dist/cjs/index.js",
          },
          "./client": {
            types: "./dist/esm/client/index.d.ts",
            import: "./dist/esm/client/index.js",
            require: "./dist/cjs/client/index.js",
          },
          "./package.json": "./package.json",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageDir, "dist", "esm", "client", "index.js"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageDir, "dist", "cjs", "client", "index.js"),
      "module.exports = {};\n",
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(true);
    expect(() =>
      assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"]),
    ).not.toThrow();
  });

  it("does not treat type-only exports as runtime entry files", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "alpha-runtime",
        version: "1.0.0",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
          },
          "./package.json": "./package.json",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "dist", "index.d.ts"), "export {};\n", "utf8");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(false);
    expect(() => assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"])).toThrow(
      /package manager install did not place bundled runtime deps/i,
    );
  });

  it("uses exported runtime entries before a stale main entry", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "alpha-runtime",
        version: "1.0.0",
        main: "./missing-main.js",
        exports: {
          ".": "./dist/index.js",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export {};\n", "utf8");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(true);
    expect(() =>
      assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"]),
    ).not.toThrow();
  });

  it("accepts staged runtime deps with exported package entry patterns", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(path.join(packageDir, "features"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "alpha-runtime",
        version: "1.0.0",
        exports: {
          "./features/*": "./features/*.js",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageDir, "features", "one.js"), "export {};\n", "utf8");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(true);
    expect(() =>
      assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"]),
    ).not.toThrow();
  });

  it("reports staged runtime deps as missing when exported package entry files are absent", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "alpha-runtime",
        version: "1.0.0",
        exports: "./dist/index.js",
      }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(false);
    expect(() => assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"])).toThrow(
      /alpha-runtime@1\.0\.0/,
    );
  });

  it("reports staged runtime deps as missing when the default package entry is absent", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "alpha-runtime", version: "1.0.0" }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(false);
    expect(() => assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"])).toThrow(
      /alpha-runtime@1\.0\.0/,
    );
  });

  it("reports staged runtime deps as missing when a package bin entry is absent", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "alpha-runtime",
        version: "1.0.0",
        bin: {
          "alpha-runtime": "bin/alpha-runtime.js",
        },
      }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(false);
    expect(() => assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"])).toThrow(
      /alpha-runtime@1\.0\.0/,
    );
  });

  it("reports staged runtime deps as missing when a declared entry file is absent", () => {
    const packageRoot = setupPolicyPackageRoot();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: makeTempDir() };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "alpha-runtime",
        version: "1.0.0",
        main: "./lib/index",
      }),
      "utf8",
    );

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env,
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "alpha-runtime@1.0.0",
    ]);
    expect(() => assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"])).toThrow(
      /alpha-runtime@1\.0\.0/,
    );
  });

  it("reports staged runtime deps as missing when a declared entry directory has no entry file", () => {
    const installRoot = makeTempDir();
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(path.join(packageDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "alpha-runtime",
        version: "1.0.0",
        main: "lib",
      }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(false);
    expect(() => assertBundledRuntimeDepsInstalled(installRoot, ["alpha-runtime@1.0.0"])).toThrow(
      /alpha-runtime@1\.0\.0/,
    );
  });

  it("reports a previous incomplete package-level install as missing", () => {
    const packageRoot = setupPolicyPackageRoot();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: makeTempDir() };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    const packageDir = path.join(installRoot, "node_modules", "alpha-runtime");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "alpha-runtime", version: "1.0.0" }),
      "utf8",
    );

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env,
    });

    expect(result.installSpecs).toEqual(["alpha-runtime@1.0.0"]);
    expect(result.missingSpecs).toEqual(["alpha-runtime@1.0.0"]);
  });

  it("reports staged package-level runtime deps as missing when the version is stale", () => {
    const packageRoot = setupPolicyPackageRoot();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: makeTempDir() };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    writeInstalledPackage(installRoot, "alpha-runtime", "0.9.0");

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env,
    });

    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "alpha-runtime@1.0.0",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("creates a package-level runtime deps plan with install and missing specs", () => {
    const packageRoot = setupPolicyPackageRoot();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: makeTempDir() };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    writeInstalledPackage(installRoot, "alpha-runtime", "0.9.0");

    const plan = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env,
    });

    expect(plan.installRootPlan.installRoot).toBe(installRoot);
    expect(plan.installSpecs).toEqual(["alpha-runtime@1.0.0"]);
    expect(plan.missingSpecs).toEqual(["alpha-runtime@1.0.0"]);
  });

  it("repairs a package-level runtime deps plan through the shared materializer", async () => {
    const packageRoot = setupPolicyPackageRoot();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: makeTempDir() };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = await repairBundledRuntimeDepsPackagePlanAsync({
      packageRoot,
      config: {},
      env,
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "alpha-runtime", "1.0.0");
      },
    });

    expect(result.repairedSpecs).toEqual(["alpha-runtime@1.0.0"]);
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["alpha-runtime@1.0.0"],
        installSpecs: ["alpha-runtime@1.0.0"],
      },
    ]);
  });

  it("reuses a compatible previous external runtime deps root during package repair", async () => {
    const packageRoot = setupPolicyPackageRoot();
    const stageDir = makeTempDir();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    const previousRoot = path.join(
      stageDir,
      path.basename(installRoot).replace("openclaw-unknown-", "openclaw-2026.4.28-"),
    );
    const progress: string[] = [];
    writeInstalledPackage(previousRoot, "alpha-runtime", "1.0.0");
    writeGeneratedRuntimeDepsManifest(previousRoot, ["alpha-runtime@1.0.0"]);

    const result = await repairBundledRuntimeDepsPackagePlanAsync({
      packageRoot,
      config: {},
      env,
      installDeps: () => {
        throw new Error("compatible staged deps should be reused");
      },
      onProgress: (message) => progress.push(message),
    });

    expect(result.repairedSpecs).toEqual([]);
    expect(result.reusedSpecs).toEqual(["alpha-runtime@1.0.0"]);
    expect(result.reusedFromRoot).toBe(previousRoot);
    expect(result.plan.missingSpecs).toEqual([]);
    expect(progress).toEqual([
      expect.stringContaining(`Reusing bundled plugin runtime deps from ${previousRoot}`),
    ]);
    expect(fs.lstatSync(path.join(installRoot, "node_modules")).isSymbolicLink()).toBe(true);
    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(true);
    expect(fs.existsSync(previousRoot)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(installRoot, "package.json"), "utf8"))).toEqual({
      name: "openclaw-runtime-deps-install",
      private: true,
      dependencies: {
        "alpha-runtime": "1.0.0",
      },
    });
  });

  it("does not reuse a compatible previous external runtime deps root with an active install lock", async () => {
    const packageRoot = setupPolicyPackageRoot();
    const stageDir = makeTempDir();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    const previousRoot = path.join(
      stageDir,
      path.basename(installRoot).replace("openclaw-unknown-", "openclaw-2026.4.28-"),
    );
    const calls: BundledRuntimeDepsInstallParams[] = [];
    writeInstalledPackage(previousRoot, "alpha-runtime", "1.0.0");
    writeGeneratedRuntimeDepsManifest(previousRoot, ["alpha-runtime@1.0.0"]);
    fs.mkdirSync(path.join(previousRoot, BUNDLED_RUNTIME_DEPS_LOCK_DIR));

    const result = await repairBundledRuntimeDepsPackagePlanAsync({
      packageRoot,
      config: {},
      env,
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "alpha-runtime", "1.0.0");
      },
    });

    expect(result.reusedSpecs).toBeUndefined();
    expect(result.reusedFromRoot).toBeUndefined();
    expect(result.repairedSpecs).toEqual(["alpha-runtime@1.0.0"]);
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["alpha-runtime@1.0.0"],
        installSpecs: ["alpha-runtime@1.0.0"],
      },
    ]);
    expect(fs.lstatSync(path.join(installRoot, "node_modules")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(previousRoot)).toBe(true);
  });

  it("does not create a reuse symlink when an earlier configured layer already satisfies the plan", async () => {
    const packageRoot = setupPolicyPackageRoot();
    const readOnlyStageDir = makeTempDir();
    const writableStageDir = makeTempDir();
    const env = {
      OPENCLAW_PLUGIN_STAGE_DIR: `${readOnlyStageDir}${path.delimiter}${writableStageDir}`,
    };
    const plan = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env,
    });
    const readOnlyRoot = plan.installRootPlan.searchRoots[0];
    writeInstalledPackage(readOnlyRoot, "alpha-runtime", "1.0.0");
    writeGeneratedRuntimeDepsManifest(readOnlyRoot, ["alpha-runtime@1.0.0"]);
    const completedPlan = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env,
    });

    const result = await repairBundledRuntimeDepsPackagePlanAsync({
      packageRoot,
      config: {},
      env,
      installDeps: () => {
        throw new Error("satisfied layered deps should not install");
      },
    });

    expect(completedPlan.missingSpecs).toEqual([]);
    expect(result.repairedSpecs).toEqual([]);
    expect(result.reusedSpecs).toBeUndefined();
    expect(fs.existsSync(path.join(plan.installRootPlan.installRoot, "node_modules"))).toBe(false);
  });

  it("does not reuse a previous external runtime deps root for a changed dependency plan", async () => {
    const packageRoot = setupPolicyPackageRoot();
    const stageDir = makeTempDir();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    const previousRoot = path.join(
      stageDir,
      path.basename(installRoot).replace("openclaw-unknown-", "openclaw-2026.4.28-"),
    );
    writeInstalledPackage(previousRoot, "alpha-runtime", "0.9.0");
    writeGeneratedRuntimeDepsManifest(previousRoot, ["alpha-runtime@0.9.0"]);
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = await repairBundledRuntimeDepsPackagePlanAsync({
      packageRoot,
      config: {},
      env,
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "alpha-runtime", "1.0.0");
      },
    });

    expect(result.repairedSpecs).toEqual(["alpha-runtime@1.0.0"]);
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["alpha-runtime@1.0.0"],
        installSpecs: ["alpha-runtime@1.0.0"],
      },
    ]);
    expect(fs.lstatSync(path.join(installRoot, "node_modules")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(previousRoot)).toBe(false);
  });

  it("does not reuse a compatible external runtime deps root from a different package key", async () => {
    const packageRoot = setupPolicyPackageRoot();
    const stageDir = makeTempDir();
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
    const previousRoot = path.join(
      stageDir,
      path.basename(installRoot).replace(/-[0-9a-f]{12}$/u, "-ffffffffffff"),
    );
    writeInstalledPackage(previousRoot, "alpha-runtime", "1.0.0");
    writeGeneratedRuntimeDepsManifest(previousRoot, ["alpha-runtime@1.0.0"]);
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = await repairBundledRuntimeDepsPackagePlanAsync({
      packageRoot,
      config: {},
      env,
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "alpha-runtime", "1.0.0");
      },
    });

    expect(result.reusedSpecs).toBeUndefined();
    expect(result.reusedFromRoot).toBeUndefined();
    expect(result.repairedSpecs).toEqual(["alpha-runtime@1.0.0"]);
    expect(calls).toHaveLength(1);
    expect(fs.lstatSync(path.join(installRoot, "node_modules")).isSymbolicLink()).toBe(false);
  });

  it("reads each bundled plugin manifest once per runtime-deps scan", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "alpha",
      deps: { "alpha-runtime": "1.0.0" },
      enabledByDefault: true,
      channels: ["alpha"],
    });
    const manifestPath = path.join(pluginRoot, "openclaw.plugin.json");
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

    createBundledRuntimeDepsPackagePlan({ packageRoot, config: {} });

    expect(
      readFileSyncSpy.mock.calls.filter((call) => path.resolve(String(call[0])) === manifestPath),
    ).toHaveLength(1);
  });

  it("reports declared package mirror deps for doctor repair", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { semver: "7.7.4", tslog: "^4.10.2" },
        openclaw: {
          bundle: {
            mirroredRootRuntimeDependencies: ["semver", "tslog"],
          },
        },
      }),
    );
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "discord",
      deps: { "discord-runtime": "1.0.0" },
      enabledByDefault: true,
    });

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "discord-runtime@1.0.0",
      "semver@7.7.4",
      "tslog@^4.10.2",
    ]);
    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "discord-runtime@1.0.0",
      "semver@7.7.4",
      "tslog@^4.10.2",
    ]);
  });

  it("includes selected plugin deps that can be used by mirrored root chunks", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { chokidar: "^5.0.0" },
      }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-core",
      deps: { chokidar: "^5.0.0" },
      enabledByDefault: true,
    });
    fs.writeFileSync(path.join(pluginRoot, "index.js"), `import "../../refresh-CZ2n5WoB.js";\n`);
    fs.writeFileSync(
      path.join(packageRoot, "dist", "refresh-CZ2n5WoB.js"),
      `import chokidar from "chokidar";\n`,
    );

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["chokidar@^5.0.0"]);
    expect(result.deps[0]?.pluginIds).toEqual(["memory-core"]);
    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["chokidar@^5.0.0"]);
  });

  it("does not include inactive bundled plugin deps", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { chokidar: "^5.0.0" },
      }),
    );
    const memoryRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-core",
      deps: { chokidar: "^5.0.0" },
    });
    fs.writeFileSync(path.join(memoryRoot, "index.js"), `import "../../refresh-CZ2n5WoB.js";\n`);
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "slack",
      deps: {},
      channels: ["slack"],
    });
    fs.writeFileSync(
      path.join(packageRoot, "dist", "refresh-CZ2n5WoB.js"),
      `import chokidar from "chokidar";\n`,
    );

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      exactPluginIds: ["slack"],
      config: {
        channels: { slack: { botToken: "xoxb-token" } },
      },
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("reports declared root package deps for mirrored root chunks", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: {
          chalk: "^5.6.2",
          jiti: "^2.6.1",
          json5: "^2.2.3",
        },
        openclaw: {
          bundle: {
            mirroredRootRuntimeDependencies: ["chalk", "jiti", "json5"],
          },
        },
      }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "whatsapp",
      deps: { "@whiskeysockets/baileys": "7.0.0-rc.9" },
      channels: ["whatsapp"],
    });
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "matrix",
      deps: { jiti: "^2.6.1" },
      channels: ["matrix"],
    });
    fs.writeFileSync(
      path.join(pluginRoot, "setup-entry.js"),
      `import "../../theme.js";\nimport "openclaw/plugin-sdk/setup";\n`,
    );
    fs.mkdirSync(path.join(packageRoot, "dist", "plugin-sdk"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "dist", "plugin-sdk", "setup.js"),
      `import "../bundled-plugin-metadata.js";\nimport "../redact.js";\n`,
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "bundled-plugin-metadata.js"),
      `import { createJiti } from "jiti";\nvoid createJiti;\n`,
    );
    fs.writeFileSync(path.join(packageRoot, "dist", "redact.js"), `import JSON5 from "json5";\n`);
    fs.writeFileSync(path.join(packageRoot, "dist", "theme.js"), `import chalk from "chalk";\n`);

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      exactPluginIds: ["whatsapp"],
      config: {
        channels: { whatsapp: { enabled: true } },
      },
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "@whiskeysockets/baileys@7.0.0-rc.9",
      "chalk@^5.6.2",
      "jiti@^2.6.1",
      "json5@^2.2.3",
    ]);
    expect(result.deps.map((dep) => dep.pluginIds)).toEqual([
      ["whatsapp"],
      ["openclaw-core"],
      ["openclaw-core"],
      ["openclaw-core"],
    ]);
    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "@whiskeysockets/baileys@7.0.0-rc.9",
      "chalk@^5.6.2",
      "jiti@^2.6.1",
      "json5@^2.2.3",
    ]);
  });

  it("reports declared package mirror deps for startup plugins without own deps", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { semver: "7.7.4", tslog: "^4.10.2" },
        openclaw: {
          bundle: {
            mirroredRootRuntimeDependencies: ["semver", "tslog"],
          },
        },
      }),
    );
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "slack",
      deps: {},
      channels: ["slack"],
    });

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      exactPluginIds: ["slack"],
      config: {
        channels: { slack: { botToken: "xoxb-token" } },
      },
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "semver@7.7.4",
      "tslog@^4.10.2",
    ]);
    expect(result.deps.map((dep) => dep.pluginIds)).toEqual([["openclaw-core"], ["openclaw-core"]]);
    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "semver@7.7.4",
      "tslog@^4.10.2",
    ]);
  });

  it("deduplicates declared package mirror deps already declared by a plugin", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { tslog: "^4.10.2" },
        openclaw: {
          bundle: {
            mirroredRootRuntimeDependencies: ["tslog"],
          },
        },
      }),
    );
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "logger-plugin",
      deps: { tslog: "^4.10.2" },
      enabledByDefault: true,
    });

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["tslog@^4.10.2"]);
    expect(result.deps[0]?.pluginIds).toEqual(["logger-plugin", "openclaw-core"]);
    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["tslog@^4.10.2"]);
  });

  it("keeps the complete staging plan without reporting present deps as missing", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.25" }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-lancedb",
      deps: {
        "@lancedb/lancedb": "^0.27.2",
        openai: "^6.34.0",
        typebox: "1.1.33",
      },
      enabledByDefault: true,
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    writeInstalledPackage(installRoot, "@lancedb/lancedb", "0.27.2");
    writeInstalledPackage(installRoot, "openai", "6.34.0");
    writeInstalledPackage(installRoot, "typebox", "1.1.33");
    writeGeneratedRuntimeDepsManifest(installRoot, [
      "@lancedb/lancedb@^0.27.2",
      "openai@^6.34.0",
      "typebox@1.1.33",
      "@mariozechner/pi-ai@0.70.5",
    ]);

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env,
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "@lancedb/lancedb@^0.27.2",
      "openai@^6.34.0",
      "typebox@1.1.33",
    ]);
    expect(result.missing).toEqual([]);
  });

  it("keeps a complete install plan while missing only absent deps", () => {
    const packageRoot = makeTempDir();
    const baselineStageDir = makeTempDir();
    const writableStageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.25" }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "slack",
      deps: {
        "@slack/web-api": "7.15.1",
        grammy: "1.37.0",
      },
      enabledByDefault: true,
    });
    const env = {
      OPENCLAW_PLUGIN_STAGE_DIR: [baselineStageDir, writableStageDir].join(path.delimiter),
    };
    const installRootPlan = resolveBundledRuntimeDependencyInstallRootPlan(pluginRoot, { env });
    writeInstalledPackage(
      installRootPlan.searchRoots[0] ?? baselineStageDir,
      "@slack/web-api",
      "7.15.1",
    );

    const result = createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: {},
      env,
    });

    expect(installRootPlan.installRoot).toContain(writableStageDir);
    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual([
      "@slack/web-api@7.15.1",
      "grammy@1.37.0",
    ]);
    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["grammy@1.37.0"]);
  });
});

describe("ensureBundledPluginRuntimeDeps", () => {
  it("installs plugin-local runtime deps when one is missing", () => {
    const packageRoot = makeTempDir();
    const extensionsRoot = path.join(packageRoot, "dist", "extensions");
    const pluginRoot = path.join(extensionsRoot, "bedrock");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "already-present": "1.0.0",
          missing: "2.0.0",
        },
      }),
    );
    fs.mkdirSync(path.join(pluginRoot, "node_modules", "already-present"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(pluginRoot, "node_modules", "already-present", "package.json"),
      JSON.stringify({ name: "already-present", version: "1.0.0" }),
    );

    const calls: Array<{
      installRoot: string;
      installExecutionRoot?: string;
      missingSpecs: string[];
      installSpecs?: string[];
    }> = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "bedrock",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["already-present@1.0.0", "missing@2.0.0"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["already-present@1.0.0", "missing@2.0.0"],
        installSpecs: ["already-present@1.0.0", "missing@2.0.0"],
      },
    ]);
    expect(installRoot).not.toBe(pluginRoot);
  });

  it("reports missing runtime deps without installing when repair is forbidden", () => {
    const packageRoot = makeTempDir();
    const extensionsRoot = path.join(packageRoot, "dist", "extensions");
    const pluginRoot = path.join(extensionsRoot, "bedrock");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          missing: "2.0.0",
        },
      }),
    );

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(() =>
      ensureBundledPluginRuntimeDeps({
        env: {},
        installMissingDeps: false,
        installDeps: () => {
          throw new Error("must not install");
        },
        pluginId: "bedrock",
        pluginRoot,
      }),
    ).toThrow(BundledRuntimeDepsMissingError);

    let caught: unknown;
    try {
      ensureBundledPluginRuntimeDeps({
        env: {},
        installMissingDeps: false,
        pluginId: "bedrock",
        pluginRoot,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BundledRuntimeDepsMissingError);
    expect((caught as BundledRuntimeDepsMissingError).missingSpecs).toEqual(["missing@2.0.0"]);
    expect((caught as BundledRuntimeDepsMissingError).installRoot).toBe(installRoot);
  });

  it("skips workspace-only runtime deps before npm install", () => {
    const packageRoot = makeTempDir();
    const extensionsRoot = path.join(packageRoot, "dist", "extensions");
    const pluginRoot = path.join(extensionsRoot, "qa-channel");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@openclaw/plugin-sdk": "workspace:*",
          "external-runtime": "^1.2.3",
          openclaw: "workspace:*",
        },
      }),
    );

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "qa-channel",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["external-runtime@^1.2.3"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["external-runtime@^1.2.3"],
        installSpecs: ["external-runtime@^1.2.3"],
      },
    ]);
    expect(installRoot).not.toBe(pluginRoot);
  });

  it("installs declared package mirror deps even when the plugin has no external deps", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { tslog: "^4.10.2" },
        openclaw: {
          bundle: {
            mirroredRootRuntimeDependencies: ["tslog"],
          },
        },
      }),
    );
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "slack");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ dependencies: {} }));

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "tokenjuice", "0.6.1");
      },
      pluginId: "slack",
      pluginRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, {
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });
    expect(result).toEqual({
      installedSpecs: ["tslog@^4.10.2"],
    });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["tslog@^4.10.2"],
        installSpecs: ["tslog@^4.10.2"],
      },
    ]);
  });

  it("uses external staging when a packaged plugin declares workspace:* deps", () => {
    // Regression guard for packaged/Docker bundled plugins whose `package.json`
    // still lists `"@openclaw/plugin-sdk": "workspace:*"` (and similar) alongside
    // concrete runtime deps. Without a distinct execution root, `npm install`
    // would resolve the plugin's own cwd manifest and fail with
    // EUNSUPPORTEDPROTOCOL on the `workspace:` protocol.
    const packageRoot = makeTempDir();
    const extensionsRoot = path.join(packageRoot, "dist", "extensions");
    const pluginRoot = path.join(extensionsRoot, "anthropic");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@openclaw/plugin-sdk": "workspace:*",
          "@anthropic-ai/sdk": "^0.50.0",
        },
      }),
    );

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "anthropic",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["@anthropic-ai/sdk@^0.50.0"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["@anthropic-ai/sdk@^0.50.0"],
        installSpecs: ["@anthropic-ai/sdk@^0.50.0"],
      },
    ]);
    expect(installRoot).not.toBe(pluginRoot);
  });

  it("installs runtime deps into an external stage dir and exposes loader aliases", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.22" }),
    );
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "slack");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@slack/web-api": "7.15.1",
        },
      }),
    );

    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env,
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "@slack/web-api", "7.15.1");
      },
      pluginId: "slack",
      pluginRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    expect(result).toEqual({
      installedSpecs: ["@slack/web-api@7.15.1"],
    });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["@slack/web-api@7.15.1"],
        installSpecs: ["@slack/web-api@7.15.1"],
      },
    ]);
    expect(installRoot).toContain(stageDir);
    expect(installRoot).not.toBe(pluginRoot);
    expect(createBundledRuntimeDependencyAliasMap({ pluginRoot, installRoot })).toEqual({
      "@slack/web-api": path.join(installRoot, "node_modules", "@slack", "web-api"),
    });

    const second = ensureBundledPluginRuntimeDeps({
      env,
      installDeps: () => {
        throw new Error("external staged deps should not reinstall");
      },
      pluginId: "slack",
      pluginRoot,
    });
    expect(second).toEqual({ installedSpecs: [] });
  });

  it("reuses compatible sibling staged deps during plugin runtime prep", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.29" }),
    );
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "slack");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@slack/web-api": "7.15.1",
        },
      }),
    );
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    const previousRoot = path.join(
      stageDir,
      path.basename(installRoot).replace("openclaw-2026.4.29-", "openclaw-2026.4.28-"),
    );
    writeInstalledPackage(previousRoot, "@slack/web-api", "7.15.1");
    writeGeneratedRuntimeDepsManifest(previousRoot, ["@slack/web-api@7.15.1"]);

    const result = ensureBundledPluginRuntimeDeps({
      env,
      installDeps: () => {
        throw new Error("compatible sibling staged deps should not reinstall");
      },
      pluginId: "slack",
      pluginRoot,
    });

    expect(result).toEqual({ installedSpecs: [] });
    expect(fs.lstatSync(path.join(installRoot, "node_modules")).isSymbolicLink()).toBe(true);
    expect(isRuntimeDepsPlanMaterialized(installRoot, ["@slack/web-api@7.15.1"])).toBe(true);
  });

  it("installs the complete plan into the final layered stage dir", () => {
    const packageRoot = makeTempDir();
    const baselineStageDir = makeTempDir();
    const writableStageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.25" }),
    );
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "slack");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@slack/web-api": "7.15.1",
          grammy: "1.37.0",
        },
      }),
    );
    const env = {
      OPENCLAW_PLUGIN_STAGE_DIR: [baselineStageDir, writableStageDir].join(path.delimiter),
    };
    const installRootPlan = resolveBundledRuntimeDependencyInstallRootPlan(pluginRoot, { env });
    const baselineRoot = installRootPlan.searchRoots[0] ?? baselineStageDir;
    writeInstalledPackage(baselineRoot, "@slack/web-api", "7.15.1");

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env,
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "@slack/web-api", "7.15.1");
        writeInstalledPackage(params.installRoot, "grammy", "1.37.0");
      },
      pluginId: "slack",
      pluginRoot,
    });

    expect(installRootPlan.installRoot).toContain(writableStageDir);
    expect(result).toEqual({
      installedSpecs: ["@slack/web-api@7.15.1", "grammy@1.37.0"],
    });
    expect(calls).toEqual([
      {
        installRoot: installRootPlan.installRoot,
        missingSpecs: ["@slack/web-api@7.15.1", "grammy@1.37.0"],
        installSpecs: ["@slack/web-api@7.15.1", "grammy@1.37.0"],
      },
    ]);
    expect(
      fs.existsSync(
        path.join(installRootPlan.installRoot, "node_modules", "@slack", "web-api", "package.json"),
      ),
    ).toBe(true);
  });

  it("stages complete package-level deps once across separate loader passes", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.22" }),
    );
    const alphaRoot = path.join(packageRoot, "dist", "extensions", "alpha");
    const betaRoot = path.join(packageRoot, "dist", "extensions", "beta");
    fs.mkdirSync(alphaRoot, { recursive: true });
    fs.mkdirSync(betaRoot, { recursive: true });
    fs.writeFileSync(
      path.join(alphaRoot, "package.json"),
      JSON.stringify({ dependencies: { "alpha-runtime": "1.0.0" } }),
    );
    fs.writeFileSync(
      path.join(betaRoot, "package.json"),
      JSON.stringify({ dependencies: { "beta-runtime": "2.0.0" } }),
    );

    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const calls: BundledRuntimeDepsInstallParams[] = [];
    const installDeps = (params: BundledRuntimeDepsInstallParams) => {
      calls.push(params);
      for (const spec of params.installSpecs ?? params.missingSpecs) {
        const name = spec.slice(0, spec.lastIndexOf("@"));
        writeInstalledPackage(params.installRoot, name, spec.slice(spec.lastIndexOf("@") + 1));
      }
    };

    ensureBundledPluginRuntimeDeps({
      config: {
        plugins: {
          entries: {
            alpha: { enabled: true },
            beta: { enabled: true },
          },
        },
      },
      env,
      installDeps,
      pluginId: "alpha",
      pluginRoot: alphaRoot,
    });
    ensureBundledPluginRuntimeDeps({
      config: {
        plugins: {
          entries: {
            alpha: { enabled: true },
            beta: { enabled: true },
          },
        },
      },
      env,
      installDeps,
      pluginId: "beta",
      pluginRoot: betaRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(alphaRoot, { env });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
        installSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
      },
    ]);
  });

  it("uses the complete package-level plan when no config is provided", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.22" }),
    );
    const alphaRoot = path.join(packageRoot, "dist", "extensions", "alpha");
    const betaRoot = path.join(packageRoot, "dist", "extensions", "beta");
    fs.mkdirSync(alphaRoot, { recursive: true });
    fs.mkdirSync(betaRoot, { recursive: true });
    fs.writeFileSync(
      path.join(alphaRoot, "package.json"),
      JSON.stringify({ dependencies: { "alpha-runtime": "1.0.0" } }),
    );
    fs.writeFileSync(
      path.join(betaRoot, "package.json"),
      JSON.stringify({ dependencies: { "beta-runtime": "2.0.0" } }),
    );

    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const calls: BundledRuntimeDepsInstallParams[] = [];
    ensureBundledPluginRuntimeDeps({
      env,
      installDeps: (params) => {
        calls.push(params);
        for (const spec of params.installSpecs ?? params.missingSpecs) {
          const name = spec.slice(0, spec.lastIndexOf("@"));
          writeInstalledPackage(params.installRoot, name, spec.slice(spec.lastIndexOf("@") + 1));
        }
      },
      pluginId: "alpha",
      pluginRoot: alphaRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(alphaRoot, { env });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
        installSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
      },
    ]);
  });

  it("excludes disabled bundled channel owners from the package-level plan", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27" }),
    );
    const browserRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "browser",
      deps: { "browser-runtime": "1.0.0" },
      enabledByDefault: true,
    });
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "telegram",
      deps: { grammy: "1.37.0" },
      channels: ["telegram"],
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(browserRoot, { env });
    writeInstalledPackage(installRoot, "browser-runtime", "1.0.0");
    writeInstalledPackage(installRoot, "grammy", "1.37.0");
    writeGeneratedRuntimeDepsManifest(installRoot, ["browser-runtime@1.0.0"]);

    const result = ensureBundledPluginRuntimeDeps({
      env,
      pluginId: "browser",
      pluginRoot: browserRoot,
      config: {
        plugins: { enabled: true },
        channels: {
          telegram: { enabled: false, botToken: "123:disabled" },
        },
      },
      installDeps: () => {
        throw new Error("already staged active deps should not reinstall");
      },
    });

    expect(result).toEqual({ installedSpecs: [] });
    expect(fs.existsSync(path.join(installRoot, ".openclaw-runtime-deps.json"))).toBe(false);
  });

  it("does not install disabled channel deps during a package-level lazy plugin repair", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27" }),
    );
    const acpxRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "acpx",
      deps: { "acpx-runtime": "1.0.0" },
      enabledByDefault: true,
    });
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "feishu",
      deps: { "@larksuiteoapi/node-sdk": "^1.62.0" },
      channels: ["feishu"],
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(acpxRoot, { env });
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env,
      pluginId: "acpx",
      pluginRoot: acpxRoot,
      config: {
        plugins: { enabled: true },
        channels: {
          feishu: { enabled: false, appId: "disabled" },
        },
      },
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "acpx-runtime", "1.0.0");
      },
    });

    expect(result).toEqual({ installedSpecs: ["acpx-runtime@1.0.0"] });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["acpx-runtime@1.0.0"],
        installSpecs: ["acpx-runtime@1.0.0"],
      },
    ]);
    expect(
      fs.existsSync(
        path.join(installRoot, "node_modules", "@larksuiteoapi", "node-sdk", "package.json"),
      ),
    ).toBe(false);
  });

  it("reruns lazy package-level repair when node_modules exists without a generated manifest", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27" }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "alpha",
      deps: { "alpha-runtime": "1.0.0" },
      enabledByDefault: true,
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      writeInstalledPackage(String(options?.cwd ?? ""), "alpha-runtime", "1.0.0");
      return {
        pid: 123,
        output: [],
        stdout: "",
        stderr: "",
        signal: null,
        status: 0,
      };
    });

    const result = ensureBundledPluginRuntimeDeps({
      env,
      pluginId: "alpha",
      pluginRoot,
    });

    expect(result).toEqual({ installedSpecs: ["alpha-runtime@1.0.0"] });
    expect(spawnSyncMock).toHaveBeenCalledOnce();
  });

  it("uses the generated manifest for the complete package-level fast path", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27" }),
    );
    const alphaRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "alpha",
      deps: { "alpha-runtime": "1.0.0" },
      enabledByDefault: true,
    });
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "beta",
      deps: { "beta-runtime": "2.0.0" },
      enabledByDefault: true,
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(alphaRoot, { env });
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    writeInstalledPackage(installRoot, "beta-runtime", "2.0.0");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"]);

    const result = ensureBundledPluginRuntimeDeps({
      env,
      pluginId: "alpha",
      pluginRoot: alphaRoot,
      installDeps: () => {
        throw new Error("current runtime deps should not reinstall");
      },
    });

    expect(result).toEqual({ installedSpecs: [] });
  });

  it("does not scan every bundled manifest when the requested package-level deps are already materialized", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.29" }),
    );
    const alphaRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "alpha",
      deps: { "alpha-runtime": "1.0.0" },
      enabledByDefault: true,
    });
    const betaRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "beta",
      deps: { "beta-runtime": "2.0.0" },
      enabledByDefault: true,
    });
    const betaManifestPath = path.join(betaRoot, "openclaw.plugin.json");
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(alphaRoot, { env });
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    writeInstalledPackage(installRoot, "beta-runtime", "2.0.0");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"]);
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

    const result = ensureBundledPluginRuntimeDeps({
      env,
      pluginId: "alpha",
      pluginRoot: alphaRoot,
      installDeps: () => {
        throw new Error("already materialized package-level deps should not reinstall");
      },
    });

    expect(result).toEqual({ installedSpecs: [] });
    expect(
      readFileSyncSpy.mock.calls.filter(
        (call) => path.resolve(String(call[0])) === betaManifestPath,
      ),
    ).toHaveLength(0);
  });

  it("does not skip missing manifest runtime deps when package deps are materialized", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.29" }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-core",
      deps: { chokidar: "5.0.0", typebox: "1.1.34" },
      runtimeDependencies: {
        localMemoryEmbedding: ["node-llama-cpp@3.18.1"],
      },
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    writeInstalledPackage(installRoot, "chokidar", "5.0.0");
    writeInstalledPackage(installRoot, "typebox", "1.1.34");
    writeGeneratedRuntimeDepsManifest(installRoot, ["chokidar@5.0.0", "typebox@1.1.34"]);
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env,
      config: {
        agents: {
          defaults: {
            memorySearch: { provider: "local" },
          },
        },
      },
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "memory-core",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["chokidar@5.0.0", "node-llama-cpp@3.18.1", "typebox@1.1.34"],
    });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["chokidar@5.0.0", "node-llama-cpp@3.18.1", "typebox@1.1.34"],
        installSpecs: ["chokidar@5.0.0", "node-llama-cpp@3.18.1", "typebox@1.1.34"],
      },
    ]);
  });

  it("accepts generated package-level runtime-deps supersets without reinstalling", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.29" }),
    );
    const alphaRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "alpha",
      deps: { "alpha-runtime": "1.0.0" },
      enabledByDefault: true,
    });
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "tokenjuice",
      deps: { tokenjuice: "0.7.0" },
      enabledByDefault: true,
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(alphaRoot, { env });
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    writeInstalledPackage(installRoot, "tokenjuice", "0.7.0");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0", "tokenjuice@0.7.0"]);

    const result = ensureBundledPluginRuntimeDeps({
      env,
      config: {
        plugins: {
          allow: ["alpha"],
          entries: { alpha: { enabled: true } },
        },
      },
      pluginId: "alpha",
      pluginRoot: alphaRoot,
      installDeps: () => {
        throw new Error("compatible runtime deps superset should not reinstall");
      },
    });

    expect(result).toEqual({ installedSpecs: [] });
  });

  it("accepts package.json runtime-deps supersets when generated metadata is absent", () => {
    const installRoot = makeTempDir();
    fs.writeFileSync(
      path.join(installRoot, "package.json"),
      JSON.stringify({
        name: "openclaw-bundled-runtime-deps",
        dependencies: {
          "alpha-runtime": "1.0.0",
          tokenjuice: "0.7.0",
        },
      }),
    );
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");

    expect(isRuntimeDepsPlanMaterialized(installRoot, ["alpha-runtime@1.0.0"])).toBe(true);
  });

  it("drops stale package versions from the next package-level plan", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27" }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "alpha",
      deps: { "alpha-runtime": "2.0.0" },
      enabledByDefault: true,
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    writeInstalledPackage(installRoot, "beta-runtime", "1.0.0");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0", "beta-runtime@1.0.0"]);
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env,
      pluginId: "alpha",
      pluginRoot,
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "alpha-runtime", "2.0.0");
      },
    });

    expect(result).toEqual({ installedSpecs: ["alpha-runtime@2.0.0"] });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["alpha-runtime@2.0.0"],
        installSpecs: ["alpha-runtime@2.0.0"],
      },
    ]);
  });

  it("reinstalls when the generated manifest is current but the installed package version is stale", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27" }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "alpha",
      deps: { "alpha-runtime": "2.0.0" },
      enabledByDefault: true,
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@2.0.0"]);
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env,
      pluginId: "alpha",
      pluginRoot,
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "alpha-runtime", "2.0.0");
      },
    });

    expect(result).toEqual({ installedSpecs: ["alpha-runtime@2.0.0"] });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["alpha-runtime@2.0.0"],
        installSpecs: ["alpha-runtime@2.0.0"],
      },
    ]);
  });

  it("reinstalls when the generated runtime-deps manifest is stale", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27" }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-lancedb",
      deps: {
        "@lancedb/lancedb": "^0.27.2",
        openai: "^6.34.0",
        typebox: "1.1.33",
      },
      enabledByDefault: true,
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    writeInstalledPackage(installRoot, "@lancedb/lancedb", "0.27.2");
    writeInstalledPackage(installRoot, "openai", "6.34.0");
    writeInstalledPackage(installRoot, "typebox", "1.1.33");
    writeGeneratedRuntimeDepsManifest(installRoot, ["@mariozechner/pi-ai@0.70.5"]);

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env,
      pluginId: "memory-lancedb",
      pluginRoot,
      installDeps: (params) => {
        calls.push(params);
      },
    });

    expect(result.installedSpecs).toEqual([
      "@lancedb/lancedb@^0.27.2",
      "openai@^6.34.0",
      "typebox@1.1.33",
    ]);
    expect(calls).toHaveLength(1);
  });

  it("does not derive a second-generation stage root from external runtime mirrors", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.25" }),
    );
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ dependencies: { grammy: "^1.42.0" } }),
    );
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    const mirroredPluginRoot = path.join(installRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(mirroredPluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(mirroredPluginRoot, "package.json"),
      JSON.stringify({ dependencies: { grammy: "^1.42.0" } }),
    );
    writeInstalledPackage(installRoot, "grammy", "1.42.0");
    writeGeneratedRuntimeDepsManifest(installRoot, ["grammy@^1.42.0"]);

    const nestedUnknownRoot = path.join(
      stageDir,
      `openclaw-unknown-${createHash("sha256").update(path.resolve(installRoot)).digest("hex").slice(0, 12)}`,
    );

    expect(resolveBundledRuntimeDependencyInstallRoot(mirroredPluginRoot, { env })).toBe(
      installRoot,
    );
    expect(resolveBundledRuntimeDependencyInstallRoot(mirroredPluginRoot, { env })).not.toBe(
      nestedUnknownRoot,
    );
    expect(
      ensureBundledPluginRuntimeDeps({
        env,
        installDeps: () => {
          throw new Error("mirrored staged deps should not reinstall into a nested stage root");
        },
        pluginId: "telegram",
        pluginRoot: mirroredPluginRoot,
      }),
    ).toEqual({ installedSpecs: [] });
  });

  it("resolves nested cache pluginRoot to enclosing versioned cache", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.25" }),
    );
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ dependencies: { grammy: "^1.42.0" } }),
    );
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });

    const nestedPluginRoot = path.join(
      installRoot,
      "dist",
      "extensions",
      "node_modules",
      "openclaw",
      "plugin-sdk",
    );
    fs.mkdirSync(nestedPluginRoot, { recursive: true });

    const resolved = resolveBundledRuntimeDependencyInstallRoot(nestedPluginRoot, { env });
    expect(resolved).toBe(installRoot);
    expect(path.basename(resolved).startsWith("openclaw-unknown-")).toBe(false);
  });

  const itSupportsPackageRootSymlinks = process.platform === "win32" ? it.skip : it;
  itSupportsPackageRootSymlinks(
    "stages bundled runtime deps to the same root for symlinked packageRoot views (issue #74963)",
    () => {
      const realParent = makeTempDir();
      const stageDir = makeTempDir();
      const realPackageRoot = path.join(realParent, "openclaw-real");
      fs.mkdirSync(realPackageRoot, { recursive: true });
      fs.writeFileSync(
        path.join(realPackageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.4.27" }),
      );
      const realPluginRoot = path.join(realPackageRoot, "dist", "extensions", "discord");
      fs.mkdirSync(realPluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(realPluginRoot, "package.json"),
        JSON.stringify({ dependencies: {} }),
      );
      const linkedPackageRoot = path.join(realParent, "openclaw-linked");
      fs.symlinkSync(realPackageRoot, linkedPackageRoot, "dir");
      const linkedPluginRoot = path.join(linkedPackageRoot, "dist", "extensions", "discord");
      const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };

      const installRootViaReal = resolveBundledRuntimeDependencyInstallRoot(realPluginRoot, {
        env,
      });
      const installRootViaLink = resolveBundledRuntimeDependencyInstallRoot(linkedPluginRoot, {
        env,
      });

      expect(installRootViaLink).toBe(installRootViaReal);
      expect(path.basename(installRootViaReal)).toMatch(/^openclaw-2026\.4\.27-[0-9a-f]{12}$/);
    },
  );

  it("prunes stale unknown and legacy versioned external runtime roots", () => {
    const stageDir = makeTempDir();
    const nowMs = Date.parse("2026-04-29T08:00:00.000Z");
    const makeRoot = (name: string, ageMs: number, locked = false) => {
      const root = path.join(stageDir, name);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "marker"), "ok\n");
      if (locked) {
        const lockDir = path.join(root, ".openclaw-runtime-deps.lock");
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(
          path.join(lockDir, "owner.json"),
          JSON.stringify({ pid: process.pid, createdAtMs: nowMs }),
        );
      }
      const mtime = new Date(nowMs - ageMs);
      fs.utimesSync(root, mtime, mtime);
      return root;
    };
    const newest = makeRoot("openclaw-unknown-newest", 1_000);
    const stale = makeRoot("openclaw-unknown-stale", 120_000);
    const locked = makeRoot("openclaw-unknown-locked", 120_000, true);
    const legacyVersioned = makeRoot("openclaw-2026.4.25-discord", 1_000);
    const lockedLegacyVersioned = makeRoot("openclaw-2026.4.25-telegram", 1_000, true);
    const modernVersioned = makeRoot("openclaw-2026.4.25-abcdef123456", 120_000);

    const result = pruneUnknownBundledRuntimeDepsRoots({
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
      nowMs,
      maxRootsToKeep: 1,
      minAgeMs: 60_000,
    });

    expect(result).toEqual({ scanned: 5, removed: 2, skippedLocked: 2 });
    expect(fs.existsSync(newest)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(locked)).toBe(true);
    expect(fs.existsSync(legacyVersioned)).toBe(false);
    expect(fs.existsSync(lockedLegacyVersioned)).toBe(true);
    expect(fs.existsSync(modernVersioned)).toBe(true);
  });

  it("uses the plugin-local stage for source-checkout runtime deps", () => {
    const packageRoot = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.25" }),
    );
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n");
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "voice-call");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ dependencies: { "voice-runtime": "1.0.0" } }),
    );
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd);
      expect(cwd).toBe(path.join(pluginRoot, ".openclaw-install-stage"));
      writeInstalledPackage(cwd, "voice-runtime", "1.0.0");
      return { status: 0, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>;
    });

    expect(
      ensureBundledPluginRuntimeDeps({
        env: {},
        pluginId: "voice-call",
        pluginRoot,
      }),
    ).toEqual({
      installedSpecs: ["voice-runtime@1.0.0"],
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(fs.lstatSync(path.join(pluginRoot, "node_modules")).isSymbolicLink()).toBe(false);

    fs.rmSync(path.join(pluginRoot, "node_modules"), { recursive: true, force: true });
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      writeInstalledPackage(String(options?.cwd), "voice-runtime", "1.0.0");
      return { status: 0, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>;
    });
    expect(
      ensureBundledPluginRuntimeDeps({
        env: {},
        pluginId: "voice-call",
        pluginRoot,
      }),
    ).toEqual({
      installedSpecs: ["voice-runtime@1.0.0"],
    });
    expect(fs.lstatSync(path.join(pluginRoot, "node_modules")).isSymbolicLink()).toBe(false);
  });

  it("keeps the complete package-level install plan for configured plugins", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.22" }),
    );
    const alphaRoot = path.join(packageRoot, "dist", "extensions", "alpha");
    const betaRoot = path.join(packageRoot, "dist", "extensions", "beta");
    fs.mkdirSync(alphaRoot, { recursive: true });
    fs.mkdirSync(betaRoot, { recursive: true });
    fs.writeFileSync(
      path.join(alphaRoot, "package.json"),
      JSON.stringify({ dependencies: { "alpha-runtime": "1.0.0" } }),
    );
    fs.writeFileSync(
      path.join(betaRoot, "package.json"),
      JSON.stringify({ dependencies: { "beta-runtime": "2.0.0" } }),
    );

    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(alphaRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "alpha-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "alpha-runtime", "package.json"),
      JSON.stringify({ name: "alpha-runtime", version: "1.0.0" }),
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);
    expect(fs.existsSync(path.join(installRoot, ".openclaw-runtime-deps.json"))).toBe(false);

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      config: {
        plugins: {
          entries: {
            alpha: { enabled: true },
            beta: { enabled: true },
          },
        },
      },
      env,
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "beta",
      pluginRoot: betaRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
    });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
        installSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
      },
    ]);
  });

  it("tracks active runtime-deps installs until the installer returns", async () => {
    const packageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "browser");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ dependencies: { "browser-runtime": "1.0.0" } }),
    );

    let idleWait: Promise<{ drained: boolean; active: number }> | null = null;
    expect(getActiveBundledRuntimeDepsInstallCount()).toBe(0);
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        expect(getActiveBundledRuntimeDepsInstallCount()).toBe(1);
        idleWait = waitForBundledRuntimeDepsInstallIdle();
        writeInstalledPackage(params.installRoot, "browser-runtime", "1.0.0");
      },
      pluginId: "browser",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["browser-runtime@1.0.0"],
    });
    expect(getActiveBundledRuntimeDepsInstallCount()).toBe(0);
    await expect(idleWait).resolves.toEqual({ drained: true, active: 0 });
  });

  it("keeps async repair locks and activity active until npm staging settles", async () => {
    const installRoot = makeTempDir();
    const lockDir = path.join(installRoot, ".openclaw-runtime-deps.lock");
    let releaseInstall!: () => void;
    const repair = repairBundledRuntimeDepsInstallRootAsync({
      installRoot,
      missingSpecs: ["browser-runtime@1.0.0"],
      installSpecs: ["browser-runtime@1.0.0"],
      env: {},
      installDeps: async (params) => {
        expect(fs.existsSync(lockDir)).toBe(true);
        expect(getActiveBundledRuntimeDepsInstallCount()).toBe(1);
        await new Promise<void>((resolve) => {
          releaseInstall = () => {
            writeInstalledPackage(params.installRoot, "browser-runtime", "1.0.0");
            resolve();
          };
        });
      },
    });

    await Promise.resolve();
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(getActiveBundledRuntimeDepsInstallCount()).toBe(1);

    releaseInstall();
    await expect(repair).resolves.toEqual({ installSpecs: ["browser-runtime@1.0.0"] });
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(getActiveBundledRuntimeDepsInstallCount()).toBe(0);
  });

  it("does not expire active runtime-deps install locks by age alone", () => {
    expect(
      shouldRemoveRuntimeDepsLock(
        { pid: 123, createdAtMs: 0 },
        Number.MAX_SAFE_INTEGER,
        () => true,
      ),
    ).toBe(false);
  });

  it("expires runtime-deps install locks whose owner PID is dead", () => {
    expect(
      shouldRemoveRuntimeDepsLock(
        // Conventional non-existent PID for dead-process simulation
        { pid: 99999, createdAtMs: 0 },
        1_000,
        () => false,
      ),
    ).toBe(true);
  });

  it("expires runtime-deps install locks whose owner PID is dead regardless of age", () => {
    expect(
      shouldRemoveRuntimeDepsLock(
        // Conventional non-existent PID for dead-process simulation
        { pid: 99999, createdAtMs: Date.now() },
        Date.now(),
        () => false,
      ),
    ).toBe(true);
  });

  it("treats a PID-alive lock with matching starttime as held by the same incarnation", () => {
    expect(
      shouldRemoveRuntimeDepsLock(
        { pid: 7, starttime: 1_000, createdAtMs: 2_000 },
        2_500,
        () => true,
        // Live PID's starttime matches the lock owner, so this is the same process.
        () => 1_000,
      ),
    ).toBe(false);
  });

  it("expires a PID-alive lock when the live PID's start-time differs (Docker PID reuse)", () => {
    // Models the failure mode that motivated this change: inside a container
    // the gateway is always PID 1 (or PID 7 with `init: true`), so a stale
    // lock from a previous incarnation looks "alive" if we only consult
    // isProcessAlive. Capturing the writer's start-time and comparing it to
    // the live PID's start-time disambiguates incarnations.
    expect(
      shouldRemoveRuntimeDepsLock(
        { pid: 7, starttime: 1_000, createdAtMs: 2_000 },
        2_500,
        () => true,
        // Same PID, but a different incarnation started later.
        () => 9_000,
      ),
    ).toBe(true);
  });

  it("treats a PID-alive lock as fresh when start-time evidence cannot be read", () => {
    // Defensive: when getProcessStartTime returns null (legacy lock with no
    // starttime, or a platform that does not expose it) we keep the
    // pre-existing behavior of trusting isAlive(pid). The only verified
    // disambiguation path is start-time evidence on both sides; without it
    // we err toward "still held" rather than risk stomping a real install.
    expect(
      shouldRemoveRuntimeDepsLock(
        { pid: 7, starttime: 1_000, createdAtMs: 0 },
        Number.MAX_SAFE_INTEGER,
        () => true,
        () => null,
      ),
    ).toBe(false);
  });

  it("expires legacy PID-alive locks without starttime or createdAtMs when lock files are stale", () => {
    expect(
      shouldRemoveRuntimeDepsLock(
        { pid: 1, lockDirMtimeMs: 1_000, ownerFileMtimeMs: 2_000 },
        602_001,
        () => true,
      ),
    ).toBe(true);
  });

  it("keeps fresh legacy PID-alive locks without starttime or createdAtMs", () => {
    expect(
      shouldRemoveRuntimeDepsLock(
        { pid: 1, lockDirMtimeMs: 1_000, ownerFileMtimeMs: 2_000 },
        602_000,
        () => true,
      ),
    ).toBe(false);
  });

  it("keeps PID-alive locks with createdAtMs even when mtimes are stale", () => {
    expect(
      shouldRemoveRuntimeDepsLock(
        { pid: 1, createdAtMs: 2_000, lockDirMtimeMs: 1_000, ownerFileMtimeMs: 1_000 },
        Number.MAX_SAFE_INTEGER,
        () => true,
      ),
    ).toBe(false);
  });

  it("does not expire fresh ownerless runtime-deps install locks", () => {
    expect(shouldRemoveRuntimeDepsLock({ lockDirMtimeMs: 1_000 }, 31_000, () => true)).toBe(false);
  });

  it("does not expire ownerless runtime-deps install locks when the owner file changed recently", () => {
    expect(
      shouldRemoveRuntimeDepsLock(
        { lockDirMtimeMs: 1_000, ownerFileMtimeMs: 31_000 },
        61_000,
        () => true,
      ),
    ).toBe(false);
  });

  it("expires ownerless runtime-deps install locks after the owner write grace window", () => {
    expect(shouldRemoveRuntimeDepsLock({ lockDirMtimeMs: 1_000 }, 31_001, () => true)).toBe(true);
  });

  it("expires ownerless runtime-deps install locks when lock and owner file are stale", () => {
    expect(
      shouldRemoveRuntimeDepsLock(
        { lockDirMtimeMs: 1_000, ownerFileMtimeMs: 2_000 },
        32_001,
        () => true,
      ),
    ).toBe(true);
  });

  it("includes runtime-deps lock owner details in timeout messages", () => {
    const message = formatRuntimeDepsLockTimeoutMessage({
      lockDir: "/tmp/openclaw-plugin/.openclaw-runtime-deps.lock",
      owner: {
        pid: 0,
        createdAtMs: 1_000,
        ownerFileState: "invalid",
        ownerFilePath: "/tmp/openclaw-plugin/.openclaw-runtime-deps.lock/owner.json",
        ownerFileMtimeMs: 2_500,
        ownerFileIsSymlink: true,
        lockDirMtimeMs: 2_000,
      },
      waitedMs: 300_123,
      nowMs: 303_000,
    });

    expect(message).toContain("waited=300123ms");
    expect(message).toContain("ownerFile=invalid");
    expect(message).toContain("ownerFileSymlink=true");
    expect(message).toContain("pid=0 alive=false");
    expect(message).toContain("ownerAge=302000ms");
    expect(message).toContain("ownerFileAge=300500ms");
    expect(message).toContain("lockAge=301000ms");
    expect(message).toContain(".openclaw-runtime-deps.lock/owner.json");
  });

  it("removes stale runtime-deps install locks before repairing deps", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "openai");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@mariozechner/pi-ai": "0.70.2",
        },
      }),
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    const lockDir = path.join(installRoot, ".openclaw-runtime-deps.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 0, createdAtMs: 0 }));

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
        fs.mkdirSync(path.join(params.installRoot, "node_modules", "@mariozechner", "pi-ai"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(params.installRoot, "node_modules", "@mariozechner", "pi-ai", "package.json"),
          JSON.stringify({ name: "@mariozechner/pi-ai", version: "0.70.2" }),
        );
      },
      pluginId: "openai",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["@mariozechner/pi-ai@0.70.2"],
    });
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("removes stale legacy PID-alive runtime-deps install locks before repairing deps", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "browser");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "browser-runtime": "1.0.0",
        },
      }),
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    const lockDir = path.join(installRoot, ".openclaw-runtime-deps.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const ownerPath = path.join(lockDir, "owner.json");
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }), "utf8");
    fs.utimesSync(ownerPath, new Date(0), new Date(0));
    fs.utimesSync(lockDir, new Date(0), new Date(0));

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
        fs.mkdirSync(path.join(params.installRoot, "node_modules", "browser-runtime"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(params.installRoot, "node_modules", "browser-runtime", "package.json"),
          JSON.stringify({ name: "browser-runtime", version: "1.0.0" }),
        );
      },
      pluginId: "browser",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["browser-runtime@1.0.0"],
    });
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("removes stale malformed runtime-deps install locks before repairing deps", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "browser");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "browser-runtime": "1.0.0",
        },
      }),
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    const lockDir = path.join(installRoot, ".openclaw-runtime-deps.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const ownerPath = path.join(lockDir, "owner.json");
    fs.writeFileSync(ownerPath, "{", "utf8");
    fs.utimesSync(ownerPath, new Date(0), new Date(0));
    fs.utimesSync(lockDir, new Date(0), new Date(0));

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
        fs.mkdirSync(path.join(params.installRoot, "node_modules", "browser-runtime"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(params.installRoot, "node_modules", "browser-runtime", "package.json"),
          JSON.stringify({ name: "browser-runtime", version: "1.0.0" }),
        );
      },
      pluginId: "browser",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["browser-runtime@1.0.0"],
    });
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  const itSupportsSymlinks = process.platform === "win32" ? it.skip : it;
  itSupportsSymlinks(
    "removes stale runtime-deps install locks with broken owner symlinks before repairing deps",
    () => {
      const packageRoot = makeTempDir();
      const pluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "browser");
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          dependencies: {
            "browser-runtime": "1.0.0",
          },
        }),
      );
      const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
      const lockDir = path.join(installRoot, ".openclaw-runtime-deps.lock");
      fs.mkdirSync(lockDir, { recursive: true });
      const ownerPath = path.join(lockDir, "owner.json");
      fs.symlinkSync("../missing-owner.json", ownerPath);
      fs.lutimesSync(ownerPath, new Date(0), new Date(0));
      fs.utimesSync(lockDir, new Date(0), new Date(0));

      const calls: BundledRuntimeDepsInstallParams[] = [];
      const result = ensureBundledPluginRuntimeDeps({
        env: {},
        installDeps: (params) => {
          calls.push(params);
          fs.mkdirSync(path.join(params.installRoot, "node_modules", "browser-runtime"), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(params.installRoot, "node_modules", "browser-runtime", "package.json"),
            JSON.stringify({ name: "browser-runtime", version: "1.0.0" }),
          );
        },
        pluginId: "browser",
        pluginRoot,
      });

      expect(result).toEqual({
        installedSpecs: ["browser-runtime@1.0.0"],
      });
      expect(calls).toHaveLength(1);
      expect(fs.existsSync(lockDir)).toBe(false);
    },
  );

  it("does not install when runtime deps are only workspace links", () => {
    const packageRoot = makeTempDir();
    const extensionsRoot = path.join(packageRoot, "dist", "extensions");
    const pluginRoot = path.join(extensionsRoot, "qa-channel");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@openclaw/plugin-sdk": "workspace:*",
          openclaw: "workspace:*",
        },
      }),
    );

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: () => {
        throw new Error("workspace-only runtime deps should not install");
      },
      pluginId: "qa-channel",
      pluginRoot,
    });

    expect(result).toEqual({ installedSpecs: [] });
  });

  it("installs missing runtime deps for source-checkout bundled plugins", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    const pluginRoot = path.join(packageRoot, "extensions", "tokenjuice");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          tokenjuice: "0.6.1",
        },
      }),
    );

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
      installDeps: (params) => {
        calls.push(params);
        writeInstalledPackage(params.installRoot, "tokenjuice", "0.6.1");
      },
      pluginId: "tokenjuice",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["tokenjuice@0.6.1"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, {
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["tokenjuice@0.6.1"],
        installSpecs: ["tokenjuice@0.6.1"],
      },
    ]);
    expect(installRoot).toContain(stageDir);
    expect(installRoot).not.toBe(pluginRoot);
    expect(
      fs.existsSync(path.join(installRoot, "node_modules", "tokenjuice", "package.json")),
    ).toBe(true);
  });

  it("keeps source-checkout bundled runtime deps in the plugin root without manifest churn", () => {
    const packageRoot = makeTempDir();
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    const pluginRoot = path.join(packageRoot, "extensions", "tokenjuice");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".openclaw-runtime-deps.json"),
      JSON.stringify({ specs: ["stale@9.9.9"] }),
    );
    writeGeneratedRuntimeDepsManifest(pluginRoot, ["tokenjuice@0.6.1"]);
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          tokenjuice: "0.6.1",
        },
      }),
    );

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "tokenjuice",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["tokenjuice@0.6.1"],
    });
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: path.join(pluginRoot, ".openclaw-install-stage"),
        missingSpecs: ["tokenjuice@0.6.1"],
        installSpecs: ["tokenjuice@0.6.1"],
      },
    ]);
    expect(resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} })).toBe(pluginRoot);
    expect(fs.existsSync(path.join(pluginRoot, ".openclaw-runtime-deps.json"))).toBe(false);
  });

  it("removes stale source-checkout manifests even when runtime deps are present", () => {
    const packageRoot = makeTempDir();
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    const pluginRoot = path.join(packageRoot, "extensions", "tokenjuice");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          tokenjuice: "0.6.1",
        },
      }),
    );
    writeInstalledPackage(pluginRoot, "tokenjuice", "0.6.1");
    fs.writeFileSync(
      path.join(pluginRoot, ".openclaw-runtime-deps.json"),
      JSON.stringify({ specs: ["stale@9.9.9"] }),
    );
    writeGeneratedRuntimeDepsManifest(pluginRoot, ["tokenjuice@0.6.1"]);

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: () => {
        throw new Error("present source-checkout runtime deps should not reinstall");
      },
      pluginId: "tokenjuice",
      pluginRoot,
    });

    expect(result).toEqual({ installedSpecs: [] });
    expect(fs.existsSync(path.join(pluginRoot, ".openclaw-runtime-deps.json"))).toBe(false);
  });

  it("treats Docker build source trees without .git as source checkouts", () => {
    const packageRoot = makeTempDir();
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    const pluginRoot = path.join(packageRoot, "extensions", "acpx");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          acpx: "0.5.3",
        },
        devDependencies: {
          "@openclaw/plugin-sdk": "workspace:*",
        },
      }),
    );

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "acpx",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["acpx@0.5.3"],
    });
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: path.join(pluginRoot, ".openclaw-install-stage"),
        missingSpecs: ["acpx@0.5.3"],
        installSpecs: ["acpx@0.5.3"],
      },
    ]);
  });

  it("does not trust package-root runtime deps for source-checkout bundled plugins", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    const pluginRoot = path.join(packageRoot, "extensions", "tokenjuice");
    fs.mkdirSync(path.join(packageRoot, "node_modules", "tokenjuice"), {
      recursive: true,
    });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          tokenjuice: "0.6.1",
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "node_modules", "tokenjuice", "package.json"),
      JSON.stringify({ name: "tokenjuice", version: "0.6.1" }),
    );
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "tokenjuice",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["tokenjuice@0.6.1"],
    });
    expect(calls).toEqual([
      {
        installRoot: resolveBundledRuntimeDependencyInstallRoot(pluginRoot, {
          env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
        }),
        missingSpecs: ["tokenjuice@0.6.1"],
        installSpecs: ["tokenjuice@0.6.1"],
      },
    ]);
  });

  it("does not reuse mismatched package-root runtime deps for source-checkout bundled plugins", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    const pluginRoot = path.join(packageRoot, "extensions", "tokenjuice");
    fs.mkdirSync(path.join(packageRoot, "node_modules", "tokenjuice"), {
      recursive: true,
    });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          tokenjuice: "0.6.1",
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "node_modules", "tokenjuice", "package.json"),
      JSON.stringify({ name: "tokenjuice", version: "0.6.0" }),
    );

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "tokenjuice",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["tokenjuice@0.6.1"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, {
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["tokenjuice@0.6.1"],
        installSpecs: ["tokenjuice@0.6.1"],
      },
    ]);
    expect(installRoot).toContain(stageDir);
    expect(installRoot).not.toBe(pluginRoot);
  });

  it("installs runtime deps for the default memory slot bundled plugin", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-core",
      deps: { chokidar: "^5.0.0" },
    });
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      config: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "memory-core",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["chokidar@^5.0.0"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["chokidar@^5.0.0"],
        installSpecs: ["chokidar@^5.0.0"],
      },
    ]);
    expect(installRoot).not.toBe(pluginRoot);
  });

  it("trusts package-manager materialized mirrors when manifest and package version match", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.27",
        dependencies: { ajv: "8.20.0" },
        openclaw: {
          bundle: {
            mirroredRootRuntimeDependencies: ["ajv"],
          },
        },
      }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "browser",
      deps: {},
      enabledByDefault: true,
    });
    const env = { OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    writeGeneratedRuntimeDepsManifest(installRoot, ["ajv@8.20.0"]);
    const ajvRoot = path.join(installRoot, "node_modules", "ajv");
    fs.mkdirSync(ajvRoot, { recursive: true });
    fs.writeFileSync(
      path.join(ajvRoot, "package.json"),
      JSON.stringify({ name: "ajv", version: "8.20.0", main: "dist/ajv.js" }),
    );
    fs.mkdirSync(path.join(ajvRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(ajvRoot, "dist", "ajv.js"), "export {};\n");

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env,
      pluginId: "browser",
      pluginRoot,
      installDeps: (params) => {
        calls.push(params);
      },
    });

    expect(result.installedSpecs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("mirrors sqlite-vec into the packaged default memory runtime deps", () => {
    const packageRoot = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.27",
        dependencies: {
          "sqlite-vec": "0.1.9",
        },
        openclaw: {
          bundle: {
            mirroredRootRuntimeDependencies: ["sqlite-vec"],
          },
        },
      }),
    );
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-core",
      deps: { chokidar: "^5.0.0", typebox: "1.1.34" },
    });
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      config: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "memory-core",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["chokidar@^5.0.0", "sqlite-vec@0.1.9", "typebox@1.1.34"],
    });
    expect(calls[0]?.installSpecs).toEqual([
      "chokidar@^5.0.0",
      "sqlite-vec@0.1.9",
      "typebox@1.1.34",
    ]);
  });

  it("installs local memory embedding runtime deps only when local memory search is configured", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-core",
      deps: { chokidar: "^5.0.0", typebox: "1.1.34" },
      runtimeDependencies: {
        localMemoryEmbedding: ["node-llama-cpp@3.18.1"],
      },
    });
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      config: {
        agents: {
          defaults: {
            memorySearch: { provider: "local" },
          },
        },
      },
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "memory-core",
      pluginRoot,
    });

    expect(result.installedSpecs).toEqual([
      "chokidar@^5.0.0",
      "node-llama-cpp@3.18.1",
      "typebox@1.1.34",
    ]);
    expect(calls[0]?.installSpecs).toEqual([
      "chokidar@^5.0.0",
      "node-llama-cpp@3.18.1",
      "typebox@1.1.34",
    ]);
  });

  it("does not install local memory embedding runtime deps for remote memory search", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-core",
      deps: { chokidar: "^5.0.0", typebox: "1.1.34" },
      runtimeDependencies: {
        localMemoryEmbedding: ["node-llama-cpp@3.18.1"],
      },
    });
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      config: {
        agents: {
          defaults: {
            memorySearch: { provider: "openai" },
          },
        },
      },
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "memory-core",
      pluginRoot,
    });

    expect(result.installedSpecs).toEqual(["chokidar@^5.0.0", "typebox@1.1.34"]);
    expect(calls[0]?.installSpecs).toEqual(["chokidar@^5.0.0", "typebox@1.1.34"]);
  });

  it("repairs external staged deps even when packaged plugin-local deps are present", () => {
    const packageRoot = makeTempDir();
    const extensionsRoot = path.join(packageRoot, "dist", "extensions");
    const pluginRoot = path.join(extensionsRoot, "discord");
    fs.mkdirSync(path.join(pluginRoot, "node_modules", "@discordjs", "voice"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@discordjs/voice": "0.19.2",
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "node_modules", "@discordjs", "voice", "package.json"),
      JSON.stringify({ name: "@discordjs/voice", version: "0.19.2" }),
    );

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
        fs.mkdirSync(path.join(params.installRoot, "node_modules", "@discordjs", "voice"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(params.installRoot, "node_modules", "@discordjs", "voice", "package.json"),
          JSON.stringify({ name: "@discordjs/voice", version: "0.19.2" }),
        );
      },
      pluginId: "discord",
      pluginRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(result).toEqual({
      installedSpecs: ["@discordjs/voice@0.19.2"],
    });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["@discordjs/voice@0.19.2"],
        installSpecs: ["@discordjs/voice@0.19.2"],
      },
    ]);
    expect(installRoot).not.toBe(pluginRoot);
  });

  it("does not trust runtime deps that only resolve from the package root", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "openai");
    fs.mkdirSync(path.join(packageRoot, "node_modules", "@mariozechner", "pi-ai"), {
      recursive: true,
    });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@mariozechner/pi-ai": "0.68.1",
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "node_modules", "@mariozechner", "pi-ai", "package.json"),
      JSON.stringify({ name: "@mariozechner/pi-ai", version: "0.68.1" }),
    );
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "openai",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["@mariozechner/pi-ai@0.68.1"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["@mariozechner/pi-ai@0.68.1"],
        installSpecs: ["@mariozechner/pi-ai@0.68.1"],
      },
    ]);
    expect(installRoot).not.toBe(pluginRoot);
  });

  it("installs deps that are only present in the package root", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "codex");
    fs.mkdirSync(path.join(packageRoot, "node_modules", "ws"), { recursive: true });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          ws: "^8.20.0",
          zod: "^4.3.6",
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "node_modules", "ws", "package.json"),
      JSON.stringify({ name: "ws", version: "8.20.0" }),
    );
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "codex",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["ws@^8.20.0", "zod@^4.3.6"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["ws@^8.20.0", "zod@^4.3.6"],
        installSpecs: ["ws@^8.20.0", "zod@^4.3.6"],
      },
    ]);
    expect(installRoot).not.toBe(pluginRoot);
  });

  it("does not treat sibling extension runtime deps as satisfying a plugin", () => {
    const packageRoot = makeTempDir();
    const extensionsRoot = path.join(packageRoot, "dist", "extensions");
    const pluginRoot = path.join(extensionsRoot, "codex");
    fs.mkdirSync(path.join(extensionsRoot, "discord", "node_modules", "zod"), {
      recursive: true,
    });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          zod: "^4.3.6",
        },
      }),
    );
    fs.writeFileSync(
      path.join(extensionsRoot, "discord", "node_modules", "zod", "package.json"),
      JSON.stringify({ name: "zod", version: "4.3.6" }),
    );
    const calls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "codex",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["zod@^4.3.6"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["zod@^4.3.6"],
        installSpecs: ["zod@^4.3.6"],
      },
    ]);
    expect(installRoot).not.toBe(pluginRoot);
  });

  it("rejects unsupported remote runtime dependency specs", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "tokenjuice");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          tokenjuice: "https://evil.example/tokenjuice.tgz",
        },
      }),
    );

    expect(() =>
      ensureBundledPluginRuntimeDeps({
        env: {},
        installDeps: () => {
          throw new Error("should not attempt install");
        },
        pluginId: "tokenjuice",
        pluginRoot,
      }),
    ).toThrow("Unsupported bundled runtime dependency spec for tokenjuice");
  });

  it("rejects invalid runtime dependency names before resolving sentinels", () => {
    const packageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "tokenjuice");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "../escape": "0.6.1",
        },
      }),
    );

    expect(() =>
      ensureBundledPluginRuntimeDeps({
        env: {},
        installDeps: () => {
          throw new Error("should not attempt install");
        },
        pluginId: "tokenjuice",
        pluginRoot,
      }),
    ).toThrow("Invalid bundled runtime dependency name");
  });

  it("reinstalls source-checkout dist deps after rebuilds remove node_modules", () => {
    const packageRoot = makeTempDir();
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "codex");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          zod: "^4.3.6",
        },
      }),
    );
    const installCalls: BundledRuntimeDepsInstallParams[] = [];

    const first = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        installCalls.push(params);
        fs.mkdirSync(path.join(params.installRoot, "node_modules", "zod"), { recursive: true });
        fs.writeFileSync(
          path.join(params.installRoot, "node_modules", "zod", "package.json"),
          JSON.stringify({ name: "zod", version: "4.3.6" }),
        );
      },
      pluginId: "codex",
      pluginRoot,
    });

    fs.rmSync(path.join(pluginRoot, "node_modules"), { recursive: true, force: true });

    const second = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        installCalls.push(params);
        writeInstalledPackage(params.installRoot, "zod", "4.3.6");
      },
      pluginId: "codex",
      pluginRoot,
    });

    expect(first).toEqual({
      installedSpecs: ["zod@^4.3.6"],
    });
    expect(second).toEqual({
      installedSpecs: ["zod@^4.3.6"],
    });
    expect(installCalls).toHaveLength(2);
    expect(fs.existsSync(path.join(pluginRoot, "node_modules", "zod", "package.json"))).toBe(true);
  });

  it("keeps source-checkout dist external staging scoped to the loaded plugin", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.27",
        dependencies: { ajv: "8.20.0" },
        openclaw: {
          bundle: {
            mirroredRootRuntimeDependencies: ["ajv"],
          },
        },
      }),
    );
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "codex");
    const siblingPluginRoot = path.join(packageRoot, "dist", "extensions", "discord");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(siblingPluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          zod: "^4.3.6",
        },
      }),
    );
    fs.writeFileSync(
      path.join(siblingPluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          ws: "^8.20.0",
        },
      }),
    );
    const installCalls: BundledRuntimeDepsInstallParams[] = [];

    const result = ensureBundledPluginRuntimeDeps({
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
      installDeps: (params) => {
        installCalls.push(params);
      },
      pluginId: "codex",
      pluginRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, {
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });
    expect(result).toEqual({
      installedSpecs: ["zod@^4.3.6"],
    });
    expect(installCalls).toEqual([
      {
        installRoot,
        missingSpecs: ["zod@^4.3.6"],
        installSpecs: ["zod@^4.3.6"],
      },
    ]);
    expect(installRoot).toContain(stageDir);
    expect(installRoot).not.toBe(pluginRoot);
  });
});
