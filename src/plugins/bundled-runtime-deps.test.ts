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
  __testing as bundledRuntimeDepsTesting,
  createBundledRuntimeDependencyAliasMap,
  createBundledRuntimeDepsInstallArgs,
  createBundledRuntimeDepsInstallEnv,
  ensureBundledPluginRuntimeDeps,
  installBundledRuntimeDeps,
  installBundledRuntimeDepsAsync,
  isWritableDirectory,
  materializeBundledRuntimeMirrorDistFile,
  repairBundledRuntimeDepsInstallRootAsync,
  resolveBundledRuntimeDependencyInstallRoot,
  resolveBundledRuntimeDependencyInstallRootPlan,
  resolveBundledRuntimeDepsNpmRunner,
  scanBundledPluginRuntimeDeps,
  type BundledRuntimeDepsInstallParams,
} from "./bundled-runtime-deps.js";

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

function writeInstalledPackage(rootDir: string, packageName: string, version: string): void {
  const packageDir = path.join(rootDir, "node_modules", ...packageName.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version }),
    "utf8",
  );
}

function writeBundledPluginPackage(params: {
  packageRoot: string;
  pluginId: string;
  deps: Record<string, string>;
  enabledByDefault?: boolean;
  channels?: string[];
}): string {
  const pluginRoot = path.join(params.packageRoot, "dist", "extensions", params.pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({ dependencies: params.deps }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      enabledByDefault: params.enabledByDefault === true,
      ...(params.channels ? { channels: params.channels } : {}),
    }),
  );
  return pluginRoot;
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
  it("uses npm_execpath through node on Windows when available", () => {
    const runner = resolveBundledRuntimeDepsNpmRunner({
      env: { npm_execpath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js" },
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      existsSync: (candidate) => candidate === "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
      npmArgs: ["install", "acpx@0.5.3"],
      platform: "win32",
    });

    expect(runner).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js", "install", "acpx@0.5.3"],
    });
  });

  it("uses package-manager-neutral install args with npm config env", () => {
    expect(createBundledRuntimeDepsInstallArgs(["acpx@0.5.3"])).toEqual([
      "install",
      "--ignore-scripts",
      "acpx@0.5.3",
    ]);
    expect(
      createBundledRuntimeDepsInstallEnv(
        {
          PATH: "/usr/bin:/bin",
          NPM_CONFIG_CACHE: "/Users/alice/.npm-uppercase",
          NPM_CONFIG_GLOBAL: "true",
          NPM_CONFIG_LOCATION: "global",
          NPM_CONFIG_PREFIX: "/Users/alice",
          npm_config_cache: "/Users/alice/.npm",
          npm_config_dry_run: "true",
          npm_config_global: "true",
          npm_config_location: "global",
          npm_config_prefix: "/opt/homebrew",
        },
        { cacheDir: "/opt/openclaw/runtime-cache" },
      ),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      npm_config_cache: "/opt/openclaw/runtime-cache",
      npm_config_dry_run: "false",
      npm_config_global: "false",
      npm_config_legacy_peer_deps: "true",
      npm_config_location: "project",
      npm_config_package_lock: "false",
      npm_config_save: "false",
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

  it("ignores pnpm npm_execpath and falls back to npm", () => {
    const execPath = "/opt/node/bin/node";
    const npmCliPath = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
    const runner = resolveBundledRuntimeDepsNpmRunner({
      env: {
        npm_execpath: "/home/runner/setup-pnpm/node_modules/.bin/pnpm.cjs",
      },
      execPath,
      existsSync: (candidate) => candidate === npmCliPath,
      npmArgs: ["install", "acpx@0.5.3"],
      platform: "linux",
    });

    expect(runner).toEqual({
      command: execPath,
      args: [npmCliPath, "install", "acpx@0.5.3"],
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

  it("prefixes PATH with the active Node directory on POSIX", () => {
    const runner = resolveBundledRuntimeDepsNpmRunner({
      env: {
        PATH: "/usr/bin:/bin",
      },
      execPath: "/opt/node/bin/node",
      existsSync: () => false,
      npmArgs: ["install", "acpx@0.5.3"],
      platform: "linux",
    });

    expect(runner).toEqual({
      command: "npm",
      args: ["install", "acpx@0.5.3"],
      env: {
        PATH: `/opt/node/bin${path.delimiter}/usr/bin:/bin`,
      },
    });
  });
});

describe("installBundledRuntimeDeps", () => {
  it("keeps already-materialized mirror chunks when source and target match", () => {
    const tempDir = makeTempDir();
    const chunkPath = path.join(tempDir, "dist", "accounts.js");
    fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
    fs.writeFileSync(
      chunkPath,
      [
        `//#region extensions/slack/src/accounts.ts`,
        `export const marker = "same-file";`,
        `//#endregion`,
        "",
      ].join("\n"),
      "utf8",
    );

    materializeBundledRuntimeMirrorDistFile(chunkPath, chunkPath);

    expect(fs.readFileSync(chunkPath, "utf8")).toContain("same-file");
  });

  it("replaces stale mirror symlinks when materializing chunks", () => {
    const tempDir = makeTempDir();
    const sourcePath = path.join(tempDir, "dist", "accounts.js");
    const targetPath = path.join(tempDir, "stage", "dist", "accounts.js");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      [
        `//#region extensions/slack/src/accounts.ts`,
        `export const marker = "source";`,
        `//#endregion`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.symlinkSync(sourcePath, targetPath, "file");

    materializeBundledRuntimeMirrorDistFile(sourcePath, targetPath);

    expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(targetPath, "utf8")).toContain("source");
  });

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

  it("uses the npm cmd shim on Windows", () => {
    const installRoot = makeTempDir();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "existsSync").mockImplementation(
      (candidate) => candidate === "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
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
        npm_execpath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
      },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js", "install", "--ignore-scripts", "acpx@0.5.3"],
      expect.objectContaining({
        cwd: installRoot,
        windowsHide: true,
        env: expect.objectContaining({
          npm_config_dry_run: "false",
          npm_config_legacy_peer_deps: "true",
          npm_config_package_lock: "false",
          npm_config_save: "false",
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

  it("reports async npm output as install progress", async () => {
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

    expect(progress).toContain("Starting npm install for bundled plugin runtime deps: acpx@0.5.3");
    expect(progress).toContain("npm stdout: added 1 package");
    expect(progress).toContain("npm stderr: npm notice");
  });

  it("emits heartbeat progress while async npm is silent", async () => {
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
      expect(progress).toContain("npm install still running (5s elapsed)");

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

  it("repairs external install roots by installing only missing specs while retaining staged deps", async () => {
    const installRoot = makeTempDir();
    writeInstalledPackage(installRoot, "alpha-runtime", "1.0.0");
    spawnMock.mockImplementation((_command, args, options) => {
      const cwd = String(options?.cwd ?? "");
      expect(args.slice(-3)).toEqual(["install", "--ignore-scripts", "beta-runtime@2.0.0"]);
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
      fs.mkdirSync(path.join(cwd, "node_modules", "tokenjuice"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, "node_modules", "tokenjuice", "package.json"),
        JSON.stringify({ name: "tokenjuice", version: "0.6.1" }),
      );
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

  it("installs the full retained set when plugin-root staging replaces node_modules", () => {
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
      expect((args ?? []).slice(-4)).toEqual([
        "install",
        "--ignore-scripts",
        "alpha-runtime@1.0.0",
        "beta-runtime@2.0.0",
      ]);
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
      installedSpecs: ["beta-runtime@2.0.0"],
      retainSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
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
    ).toThrow(`npm install did not place bundled runtime deps in ${installRoot}: tokenjuice@0.6.1`);
  });

  it("cleans an owned isolated execution root after copying node_modules back", () => {
    const installRoot = makeTempDir();
    const installExecutionRoot = path.join(installRoot, ".openclaw-install-stage");
    spawnSyncMock.mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd ?? "");
      fs.mkdirSync(path.join(cwd, "node_modules", "tokenjuice"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, "node_modules", "tokenjuice", "package.json"),
        JSON.stringify({ name: "tokenjuice", version: "0.6.1" }),
      );
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
      fs.mkdirSync(path.join(cwd, "node_modules", "tokenjuice"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, "node_modules", "tokenjuice", "package.json"),
        JSON.stringify({ name: "tokenjuice", version: "0.6.1" }),
      );
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
      createBundledRuntimeDepsInstallArgs(["tokenjuice@https://evil.example/t.tgz"]),
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

describe("scanBundledPluginRuntimeDeps config policy", () => {
  type RuntimeDepsConfigCase = {
    name: string;
    config: Parameters<typeof scanBundledPluginRuntimeDeps>[0]["config"];
    includeConfiguredChannels: boolean;
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
  ];

  it.each(cases)("$name", ({ config, includeConfiguredChannels, expectedDeps }) => {
    const result = scanBundledPluginRuntimeDeps({
      packageRoot: setupPolicyPackageRoot(),
      config,
      includeConfiguredChannels,
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual(expectedDeps);
    expect(result.conflicts).toEqual([]);
  });

  it("honors deny and disabled entries when scanning an explicit effective plugin set", () => {
    const packageRoot = setupPolicyPackageRoot();

    const denied = scanBundledPluginRuntimeDeps({
      packageRoot,
      pluginIds: ["telegram"],
      config: {
        plugins: { deny: ["telegram"] },
        channels: { telegram: { enabled: true } },
      },
    });
    const disabled = scanBundledPluginRuntimeDeps({
      packageRoot,
      pluginIds: ["telegram"],
      config: {
        plugins: { entries: { telegram: { enabled: false } } },
        channels: { telegram: { enabled: true } },
      },
    });
    const allowed = scanBundledPluginRuntimeDeps({
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
    const result = scanBundledPluginRuntimeDeps({
      packageRoot: setupPolicyPackageRoot(),
      selectedPluginIds: ["telegram"],
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

    scanBundledPluginRuntimeDeps({ packageRoot, config: {} });

    expect(
      readFileSyncSpy.mock.calls.filter((call) => path.resolve(String(call[0])) === manifestPath),
    ).toHaveLength(1);
  });

  it("reports missing mirrored core runtime deps for doctor repair", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { semver: "7.7.4", tslog: "^4.10.2" },
      }),
    );
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "discord",
      deps: { "discord-runtime": "1.0.0" },
      enabledByDefault: true,
    });

    const result = scanBundledPluginRuntimeDeps({
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

  it("reports missing root-dist mirror deps for selected bundled plugins", () => {
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
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-core",
      deps: { chokidar: "^5.0.0" },
      enabledByDefault: true,
    });
    fs.writeFileSync(
      path.join(packageRoot, "dist", "refresh-CZ2n5WoB.js"),
      `import chokidar from "chokidar";\n`,
    );

    const result = scanBundledPluginRuntimeDeps({
      packageRoot,
      config: {},
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["chokidar@^5.0.0"]);
    expect(result.deps[0]?.pluginIds).toEqual(["memory-core"]);
    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["chokidar@^5.0.0"]);
  });

  it("does not report root-dist mirror deps for inactive bundled plugin owners", () => {
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
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "memory-core",
      deps: { chokidar: "^5.0.0" },
    });
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

    const result = scanBundledPluginRuntimeDeps({
      packageRoot,
      selectedPluginIds: ["slack"],
      config: {
        channels: { slack: { botToken: "xoxb-token" } },
      },
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("reports missing mirrored core runtime deps for startup plugins without own deps", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { tslog: "^4.10.2" },
      }),
    );
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "slack",
      deps: {},
      channels: ["slack"],
    });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot,
      selectedPluginIds: ["slack"],
      config: {
        channels: { slack: { botToken: "xoxb-token" } },
      },
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["tslog@^4.10.2"]);
    expect(result.deps[0]?.pluginIds).toEqual(["openclaw-core"]);
    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["tslog@^4.10.2"]);
  });

  it("deduplicates mirrored core runtime deps already declared by a plugin", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { tslog: "^4.10.2" },
      }),
    );
    writeBundledPluginPackage({
      packageRoot,
      pluginId: "logger-plugin",
      deps: { tslog: "^4.10.2" },
      enabledByDefault: true,
    });

    const result = scanBundledPluginRuntimeDeps({
      packageRoot,
      config: {},
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });

    expect(result.deps.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["tslog@^4.10.2"]);
    expect(result.deps[0]?.pluginIds).toEqual(["logger-plugin", "openclaw-core"]);
    expect(result.missing.map((dep) => `${dep.name}@${dep.version}`)).toEqual(["tslog@^4.10.2"]);
  });

  it("resolves runtime deps from layered external stage dirs", () => {
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

    const result = scanBundledPluginRuntimeDeps({
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
      retainSpecs: ["previous@3.0.0"],
    });

    expect(result).toEqual({
      installedSpecs: ["already-present@1.0.0", "missing@2.0.0"],
      retainSpecs: ["already-present@1.0.0", "missing@2.0.0", "previous@3.0.0"],
    });
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["already-present@1.0.0", "missing@2.0.0"],
        installSpecs: ["already-present@1.0.0", "missing@2.0.0", "previous@3.0.0"],
      },
    ]);
    expect(installRoot).not.toBe(pluginRoot);
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
      retainSpecs: ["external-runtime@^1.2.3"],
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

  it("installs mirrored core logger deps even when the plugin has no external deps", () => {
    const packageRoot = makeTempDir();
    const stageDir = makeTempDir();
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.25",
        dependencies: { tslog: "^4.10.2" },
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
      },
      pluginId: "slack",
      pluginRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, {
      env: { OPENCLAW_PLUGIN_STAGE_DIR: stageDir },
    });
    expect(result).toEqual({
      installedSpecs: ["tslog@^4.10.2"],
      retainSpecs: ["tslog@^4.10.2"],
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
      retainSpecs: ["@anthropic-ai/sdk@^0.50.0"],
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
        fs.mkdirSync(path.join(params.installRoot, "node_modules", "@slack", "web-api"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(params.installRoot, "node_modules", "@slack", "web-api", "package.json"),
          JSON.stringify({ name: "@slack/web-api", version: "7.15.1" }),
        );
      },
      pluginId: "slack",
      pluginRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    expect(result).toEqual({
      installedSpecs: ["@slack/web-api@7.15.1"],
      retainSpecs: ["@slack/web-api@7.15.1"],
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
    expect(second).toEqual({ installedSpecs: [], retainSpecs: [] });
  });

  it("installs only missing deps into the final layered stage dir", () => {
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
        fs.rmSync(path.join(params.installRoot, "node_modules", "@slack", "web-api"), {
          recursive: true,
          force: true,
        });
        writeInstalledPackage(params.installRoot, "grammy", "1.37.0");
      },
      pluginId: "slack",
      pluginRoot,
    });

    expect(installRootPlan.installRoot).toContain(writableStageDir);
    expect(result).toEqual({
      installedSpecs: ["grammy@1.37.0"],
      retainSpecs: ["grammy@1.37.0"],
    });
    expect(calls).toEqual([
      {
        installRoot: installRootPlan.installRoot,
        missingSpecs: ["grammy@1.37.0"],
        installSpecs: ["grammy@1.37.0"],
      },
    ]);
    expect(
      fs.realpathSync(path.join(installRootPlan.installRoot, "node_modules", "@slack", "web-api")),
    ).toBe(fs.realpathSync(path.join(baselineRoot, "node_modules", "@slack", "web-api")));
  });

  it("retains external staged deps across separate loader passes", () => {
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
        fs.mkdirSync(path.join(params.installRoot, "node_modules", name), { recursive: true });
        fs.writeFileSync(
          path.join(params.installRoot, "node_modules", name, "package.json"),
          JSON.stringify({ name, version: spec.slice(spec.lastIndexOf("@") + 1) }),
        );
      }
    };

    ensureBundledPluginRuntimeDeps({
      env,
      installDeps,
      pluginId: "alpha",
      pluginRoot: alphaRoot,
    });
    ensureBundledPluginRuntimeDeps({
      env,
      installDeps,
      pluginId: "beta",
      pluginRoot: betaRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(alphaRoot, { env });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["alpha-runtime@1.0.0"],
        installSpecs: ["alpha-runtime@1.0.0"],
      },
      {
        installRoot,
        missingSpecs: ["beta-runtime@2.0.0"],
        installSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
      },
    ]);
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
    fs.mkdirSync(path.join(installRoot, "node_modules", "grammy"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "grammy", "package.json"),
      JSON.stringify({ name: "grammy", version: "1.42.0" }),
    );

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
    ).toEqual({ installedSpecs: [], retainSpecs: [] });
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

  it("links source-checkout runtime deps from the cache instead of copying them", () => {
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
      expect(cwd).toContain(path.join(".local", "bundled-plugin-runtime-deps"));
      const depRoot = path.join(cwd, "node_modules", "voice-runtime");
      fs.mkdirSync(depRoot, { recursive: true });
      fs.writeFileSync(
        path.join(depRoot, "package.json"),
        JSON.stringify({ name: "voice-runtime", version: "1.0.0" }),
      );
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
      retainSpecs: ["voice-runtime@1.0.0"],
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(fs.lstatSync(path.join(pluginRoot, "node_modules")).isSymbolicLink()).toBe(true);

    fs.rmSync(path.join(pluginRoot, "node_modules"), { recursive: true, force: true });
    expect(
      ensureBundledPluginRuntimeDeps({
        env: {},
        installDeps: () => {
          throw new Error("cache restore should not reinstall");
        },
        pluginId: "voice-call",
        pluginRoot,
      }),
    ).toEqual({ installedSpecs: [], retainSpecs: [] });
    expect(fs.lstatSync(path.join(pluginRoot, "node_modules")).isSymbolicLink()).toBe(true);
  });

  it("retains existing staged deps without a retained manifest before shared installs", () => {
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
    expect(fs.existsSync(path.join(installRoot, ".openclaw-runtime-deps.json"))).toBe(false);

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env,
      installDeps: (params) => {
        calls.push(params);
      },
      pluginId: "beta",
      pluginRoot: betaRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["beta-runtime@2.0.0"],
      retainSpecs: ["alpha-runtime@1.0.0", "beta-runtime@2.0.0"],
    });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["beta-runtime@2.0.0"],
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
      retainSpecs: ["browser-runtime@1.0.0"],
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
      bundledRuntimeDepsTesting.shouldRemoveRuntimeDepsLock(
        { pid: 123, createdAtMs: 0 },
        Number.MAX_SAFE_INTEGER,
        () => true,
      ),
    ).toBe(false);
  });

  it("does not expire fresh ownerless runtime-deps install locks", () => {
    expect(
      bundledRuntimeDepsTesting.shouldRemoveRuntimeDepsLock(
        { lockDirMtimeMs: 1_000 },
        31_000,
        () => true,
      ),
    ).toBe(false);
  });

  it("does not expire ownerless runtime-deps install locks when the owner file changed recently", () => {
    expect(
      bundledRuntimeDepsTesting.shouldRemoveRuntimeDepsLock(
        { lockDirMtimeMs: 1_000, ownerFileMtimeMs: 31_000 },
        61_000,
        () => true,
      ),
    ).toBe(false);
  });

  it("expires ownerless runtime-deps install locks after the owner write grace window", () => {
    expect(
      bundledRuntimeDepsTesting.shouldRemoveRuntimeDepsLock(
        { lockDirMtimeMs: 1_000 },
        31_001,
        () => true,
      ),
    ).toBe(true);
  });

  it("expires ownerless runtime-deps install locks when lock and owner file are stale", () => {
    expect(
      bundledRuntimeDepsTesting.shouldRemoveRuntimeDepsLock(
        { lockDirMtimeMs: 1_000, ownerFileMtimeMs: 2_000 },
        32_001,
        () => true,
      ),
    ).toBe(true);
  });

  it("includes runtime-deps lock owner details in timeout messages", () => {
    const message = bundledRuntimeDepsTesting.formatRuntimeDepsLockTimeoutMessage({
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
      retainSpecs: ["@mariozechner/pi-ai@0.70.2"],
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
      retainSpecs: ["browser-runtime@1.0.0"],
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
        retainSpecs: ["browser-runtime@1.0.0"],
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

    expect(result).toEqual({ installedSpecs: [], retainSpecs: [] });
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
      },
      pluginId: "tokenjuice",
      pluginRoot,
    });

    expect(result).toEqual({
      installedSpecs: ["tokenjuice@0.6.1"],
      retainSpecs: ["tokenjuice@0.6.1"],
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
      JSON.parse(fs.readFileSync(path.join(installRoot, ".openclaw-runtime-deps.json"), "utf8")),
    ).toEqual({ specs: ["tokenjuice@0.6.1"] });
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
      retainSpecs: ["tokenjuice@0.6.1"],
    });
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: expect.stringContaining(
          path.join(".local", "bundled-plugin-runtime-deps"),
        ),
        linkNodeModulesFromExecutionRoot: true,
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
    fs.mkdirSync(path.join(pluginRoot, "node_modules", "tokenjuice"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          tokenjuice: "0.6.1",
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "node_modules", "tokenjuice", "package.json"),
      JSON.stringify({ name: "tokenjuice", version: "0.6.1" }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, ".openclaw-runtime-deps.json"),
      JSON.stringify({ specs: ["stale@9.9.9"] }),
    );

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: () => {
        throw new Error("present source-checkout runtime deps should not reinstall");
      },
      pluginId: "tokenjuice",
      pluginRoot,
    });

    expect(result).toEqual({ installedSpecs: [], retainSpecs: [] });
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
      retainSpecs: ["acpx@0.5.3"],
    });
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: expect.stringContaining(
          path.join(".local", "bundled-plugin-runtime-deps"),
        ),
        linkNodeModulesFromExecutionRoot: true,
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
      retainSpecs: ["tokenjuice@0.6.1"],
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
      retainSpecs: ["tokenjuice@0.6.1"],
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

  it("repairs external staged deps even when packaged plugin-local deps are present", () => {
    const packageRoot = makeTempDir();
    const extensionsRoot = path.join(packageRoot, "dist", "extensions");
    const pluginRoot = path.join(extensionsRoot, "discord");
    fs.mkdirSync(path.join(pluginRoot, "node_modules", "@buape", "carbon"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        dependencies: {
          "@buape/carbon": "0.16.0",
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "node_modules", "@buape", "carbon", "package.json"),
      JSON.stringify({ name: "@buape/carbon", version: "0.16.0" }),
    );

    const calls: BundledRuntimeDepsInstallParams[] = [];
    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: (params) => {
        calls.push(params);
        fs.mkdirSync(path.join(params.installRoot, "node_modules", "@buape", "carbon"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(params.installRoot, "node_modules", "@buape", "carbon", "package.json"),
          JSON.stringify({ name: "@buape/carbon", version: "0.16.0" }),
        );
      },
      pluginId: "discord",
      pluginRoot,
    });

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env: {} });
    expect(result).toEqual({
      installedSpecs: ["@buape/carbon@0.16.0"],
      retainSpecs: ["@buape/carbon@0.16.0"],
    });
    expect(calls).toEqual([
      {
        installRoot,
        missingSpecs: ["@buape/carbon@0.16.0"],
        installSpecs: ["@buape/carbon@0.16.0"],
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
      retainSpecs: ["@mariozechner/pi-ai@0.68.1"],
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
      retainSpecs: ["ws@^8.20.0", "zod@^4.3.6"],
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
      retainSpecs: ["zod@^4.3.6"],
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

  it("rehydrates source-checkout dist deps from cache after rebuilds", () => {
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
      installDeps: () => {
        throw new Error("cached runtime deps should not reinstall");
      },
      pluginId: "codex",
      pluginRoot,
    });

    expect(first).toEqual({
      installedSpecs: ["zod@^4.3.6"],
      retainSpecs: ["zod@^4.3.6"],
    });
    expect(second).toEqual({ installedSpecs: [], retainSpecs: [] });
    expect(installCalls).toHaveLength(1);
    expect(fs.existsSync(path.join(pluginRoot, "node_modules", "zod", "package.json"))).toBe(true);
  });
});
