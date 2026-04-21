import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBundledRuntimeDepsInstallArgs,
  createBundledRuntimeDepsInstallEnv,
  ensureBundledPluginRuntimeDeps,
  installBundledRuntimeDeps,
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

  it("falls back to npm.cmd through shell on Windows", () => {
    const runner = resolveBundledRuntimeDepsNpmRunner({
      env: {},
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      existsSync: () => false,
      npmArgs: ["install"],
      platform: "win32",
    });

    expect(runner).toEqual({
      command: "npm.cmd",
      args: ["install"],
      shell: true,
    });
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
  it("uses the npm cmd shim on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
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
      env: { npm_config_prefix: "C:\\prefix", PATH: "C:\\node" },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "npm.cmd",
      ["install", "--ignore-scripts", "acpx@0.5.3"],
      expect.objectContaining({
        cwd: "C:\\openclaw",
        shell: true,
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
        missingSpecs: ["external-runtime@^1.2.3"],
        installSpecs: ["external-runtime@^1.2.3"],
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

  it("skips install when runtime deps resolve from the package root", () => {
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
          "@mariozechner/pi-ai": "0.67.68",
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageRoot, "node_modules", "@mariozechner", "pi-ai", "package.json"),
      JSON.stringify({ name: "@mariozechner/pi-ai", version: "0.67.68" }),
    );

    const result = ensureBundledPluginRuntimeDeps({
      env: {},
      installDeps: () => {
        throw new Error("package-root runtime deps should not reinstall");
      },
      pluginId: "openai",
      pluginRoot,
    });

    expect(result).toEqual({ installedSpecs: [], retainSpecs: [] });
  });

  it("installs only deps missing from plugin and package-root resolution", () => {
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
      installedSpecs: ["zod@^4.3.6"],
      retainSpecs: ["ws@^8.20.0", "zod@^4.3.6"],
    });
    expect(calls).toEqual([
      {
        installRoot: pluginRoot,
        missingSpecs: ["zod@^4.3.6"],
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
        missingSpecs: ["zod@^4.3.6"],
        installSpecs: ["zod@^4.3.6"],
      },
    ]);
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
