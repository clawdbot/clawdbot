import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBundledRuntimeDependencyAliasMap,
  createBundledRuntimeDepsInstallArgs,
  createBundledRuntimeDepsInstallEnv,
  ensureBundledPluginRuntimeDeps,
  installBundledRuntimeDeps,
  isWritableDirectory,
  resolveBundledRuntimeDependencyInstallRoot,
  resolveBundledRuntimeDepsNpmRunner,
  type BundledRuntimeDepsInstallParams,
} from "./bundled-runtime-deps.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-deps-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
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
      createBundledRuntimeDepsInstallEnv({
        PATH: "/usr/bin:/bin",
        npm_config_global: "true",
        npm_config_prefix: "/opt/homebrew",
      }),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      npm_config_legacy_peer_deps: "true",
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
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "existsSync").mockImplementation(
      (candidate) => candidate === "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
    );
    spawnSyncMock.mockReturnValue({
      pid: 123,
      output: [],
      stdout: "",
      stderr: "",
      signal: null,
      status: 0,
    });

    installBundledRuntimeDeps({
      installRoot: "C:\\openclaw",
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
        cwd: "C:\\openclaw",
        env: expect.objectContaining({
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
      installedSpecs: ["missing@2.0.0"],
      retainSpecs: ["already-present@1.0.0", "missing@2.0.0", "previous@3.0.0"],
    });
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: path.join(pluginRoot, ".openclaw-install-stage"),
        missingSpecs: ["missing@2.0.0"],
        installSpecs: ["already-present@1.0.0", "missing@2.0.0", "previous@3.0.0"],
      },
    ]);
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
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: path.join(pluginRoot, ".openclaw-install-stage"),
        missingSpecs: ["external-runtime@^1.2.3"],
        installSpecs: ["external-runtime@^1.2.3"],
      },
    ]);
  });

  it("stages plugin-root install when the plugin's own package.json declares workspace:* deps", () => {
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
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: path.join(pluginRoot, ".openclaw-install-stage"),
        missingSpecs: ["@anthropic-ai/sdk@^0.50.0"],
        installSpecs: ["@anthropic-ai/sdk@^0.50.0"],
      },
    ]);
    // The stage dir must be distinct from the plugin root so npm does not read
    // the plugin's cwd manifest during install.
    const installExecutionRoot = calls[0]?.installExecutionRoot;
    expect(installExecutionRoot).toBeDefined();
    expect(path.resolve(installExecutionRoot ?? "")).not.toEqual(path.resolve(pluginRoot));
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

  it("skips install when staged plugin-local runtime deps are present", () => {
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

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: () => {
        throw new Error("staged plugin-local deps should not reinstall");
      },
      pluginId: "discord",
      pluginRoot,
    });

    expect(result).toEqual({ installedSpecs: [], retainSpecs: [] });
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
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: path.join(pluginRoot, ".openclaw-install-stage"),
        missingSpecs: ["@mariozechner/pi-ai@0.68.1"],
        installSpecs: ["@mariozechner/pi-ai@0.68.1"],
      },
    ]);
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
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: path.join(pluginRoot, ".openclaw-install-stage"),
        missingSpecs: ["ws@^8.20.0", "zod@^4.3.6"],
        installSpecs: ["ws@^8.20.0", "zod@^4.3.6"],
      },
    ]);
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
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        installExecutionRoot: path.join(pluginRoot, ".openclaw-install-stage"),
        missingSpecs: ["zod@^4.3.6"],
        installSpecs: ["zod@^4.3.6"],
      },
    ]);
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
