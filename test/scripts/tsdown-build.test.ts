// Tsdown Build tests cover tsdown build script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveWindowsTaskkillPath } from "../../scripts/lib/windows-taskkill.mjs";
import {
  cleanTsdownOutputRoots,
  createTsdownOutputScanner,
  listTsdownOutputRoots,
  parseTsdownBuildArgs,
  pruneSourceCheckoutBundledPluginNodeModules,
  pruneStaleRootChunkFiles,
  pruneUntrackedGeneratedSourceDeclarations,
  resolveTsdownBuildInvocation,
  resolveTsdownBuildInvocations,
  runTsdownBuildInvocation,
  signalTsdownBuildProcessTree,
} from "../../scripts/tsdown-build.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const NO_MEMORY_LIMIT = {
  cgroupMemoryLimitPaths: [],
  procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
};

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

async function expectPathMissing(targetPath: string) {
  let statError: unknown;
  try {
    await fsPromises.stat(targetPath);
  } catch (error) {
    statError = error;
  }
  expect(statError).toBeInstanceOf(Error);
  if (!(statError instanceof Error)) {
    throw new Error("expected missing path error");
  }
  expect(Reflect.get(statError, "code")).toBe("ENOENT");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timed out waiting for pid ${pid} to exit`);
}

function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child did not close before timeout"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe("resolveTsdownBuildInvocation", () => {
  it("parses wrapper help before any tsdown work", () => {
    expect(parseTsdownBuildArgs(["--help"])).toEqual({ forwardedArgs: [], help: true });
    expect(parseTsdownBuildArgs(["--format", "esm"])).toEqual({
      forwardedArgs: ["--format", "esm"],
      help: false,
    });
  });

  it("prints wrapper help without invoking pnpm or tsdown", () => {
    const result = spawnSync(process.execPath, ["scripts/tsdown-build.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/tsdown-build.mjs");
    expect(result.stdout).not.toContain("Scope:");
    expect(result.stdout).not.toContain("pnpm");
  });

  it("forwards explicit tsdown args after wrapper args are parsed", () => {
    const result = resolveTsdownBuildInvocation({
      args: ["--format", "esm"],
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(result.args).toContain("tsdown");
    expect(result.args).toEqual(expect.arrayContaining(["--config-loader", "unrun", "--no-clean"]));
    expect(result.args.slice(-2)).toEqual(["--format", "esm"]);
  });

  it("builds AI package declarations before the main graph", () => {
    const results = resolveTsdownBuildInvocations({
      args: ["--format", "esm"],
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.args).toEqual(
      expect.arrayContaining(["--config", "tsdown.ai.config.ts", "--format", "esm"]),
    );
    expect(results[1]?.args).not.toContain("tsdown.ai.config.ts");
  });

  it("routes Windows tsdown builds through the pnpm runner instead of shell=true", () => {
    const rootDir = createTempDir("openclaw-pnpm-runner-");
    const npmExecPath = path.join(rootDir, "pnpm.cjs");
    fs.writeFileSync(npmExecPath, "console.log('pnpm');\n");

    const result = resolveTsdownBuildInvocation({
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath,
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        npmExecPath,
        "exec",
        "tsdown",
        "--config-loader",
        "unrun",
        "--logLevel",
        "warn",
        "--no-clean",
      ],
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsVerbatimArguments: undefined,
        env: { NODE_OPTIONS: "--max-old-space-size=8192" },
      },
    });
  });

  it("keeps inherited Windows tsdown heap settings at the Windows build cap", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\repo\\pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=8192" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=8192");
  });

  it("clamps explicit Windows tsdown heap settings to the Windows build cap", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\repo\\pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=12288" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=8192");
  });

  it("preserves explicit tsdown heap settings", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=12288" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=12288");
  });

  it("raises inherited lower tsdown heap settings to the build default", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=4096" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=12288");
  });

  it("raises split inherited lower tsdown heap settings to the build default", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size 4096" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=12288");
  });

  it("keeps default tsdown heap below the container memory limit", () => {
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      cgroupMemoryLimitBytes: 7 * 1024 * 1024 * 1024,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--max-old-space-size=6400");
  });

  it("clamps explicit tsdown heap settings to the container memory limit", () => {
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=12288" },
      cgroupMemoryLimitBytes: 7 * 1024 * 1024 * 1024,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=6400");
  });

  it("honors OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB over platform and memory defaults", () => {
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "3072" },
      cgroupMemoryLimitBytes: 7 * 1024 * 1024 * 1024,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--max-old-space-size=3072");
  });

  it("keeps memory detection when OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB is blank", () => {
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "  " },
      cgroupMemoryLimitBytes: 7 * 1024 * 1024 * 1024,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--max-old-space-size=6400");
  });

  it("uses OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB to normalize inherited NODE_OPTIONS", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\repo\\pnpm.cjs",
      env: {
        NODE_OPTIONS: "--trace-warnings --max-old-space-size=12288",
        OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "4096",
      },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=4096");
  });

  it("rejects malformed OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB values", () => {
    for (const value of ["0", "-1", "1.5", "1e3", "4096mb", "9007199254740992"]) {
      expect(() =>
        resolveTsdownBuildInvocation({
          nodeExecPath: "/usr/bin/node",
          npmExecPath: "/tmp/pnpm.cjs",
          env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: value },
          ...NO_MEMORY_LIMIT,
        }),
      ).toThrow("OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB must be");
    }
  });

  it("falls back to proc meminfo when the cgroup memory limit is unbounded", () => {
    const fsMock = {
      readFileSync: vi.fn((filePath: string) => {
        if (filePath === "/test/memory.max") {
          return "max\n";
        }
        if (filePath === "/test/meminfo") {
          return "MemTotal: 7340032 kB\n";
        }
        throw new Error(`unexpected path ${filePath}`);
      }),
    };
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      fs: fsMock,
      cgroupMemoryLimitPaths: ["/test/memory.max"],
      procMeminfoPath: "/test/meminfo",
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--max-old-space-size=6400");
  });

  it("can run tsdown without invoking pnpm", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result).toEqual({
      command: "/usr/bin/node",
      args: [
        "node_modules/tsdown/dist/run.mjs",
        "--config-loader",
        "unrun",
        "--logLevel",
        "warn",
        "--no-clean",
      ],
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsVerbatimArguments: undefined,
        env: {
          NODE_OPTIONS: "--max-old-space-size=12288",
          OPENCLAW_BUILD_ALL_NO_PNPM: "1",
        },
      },
    });
  });

  it("keeps source-checkout prune best-effort", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rmSync = vi.spyOn(fs, "rmSync");

    rmSync.mockImplementation(() => {
      throw new Error("locked");
    });

    expect(
      pruneSourceCheckoutBundledPluginNodeModules({
        cwd: process.cwd(),
      }),
    ).toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "tsdown: could not prune bundled plugin source node_modules: Error: locked",
    );

    warn.mockRestore();
    rmSync.mockRestore();
  });

  it("prunes stale hashed root chunk files but keeps stable aliases and nested assets", async () => {
    const rootDir = createTempDir("openclaw-tsdown-build-");
    const distDir = path.join(rootDir, "dist");
    const distRuntimeDir = path.join(rootDir, "dist-runtime");
    await fsPromises.mkdir(path.join(distDir, "control-ui"), { recursive: true });
    await fsPromises.mkdir(distRuntimeDir, { recursive: true });
    await fsPromises.writeFile(path.join(distDir, "delegate-BPjCe4gC.js"), "old delegate\n");
    await fsPromises.writeFile(path.join(distDir, "compact.runtime-2DiEmVcA.js"), "old runtime\n");
    await fsPromises.writeFile(path.join(distDir, "compact.runtime.js"), "stable alias\n");
    await fsPromises.writeFile(path.join(distDir, "entry.js"), "entry\n");
    await fsPromises.writeFile(path.join(distDir, "control-ui", "index.html"), "asset\n");
    await fsPromises.writeFile(
      path.join(distRuntimeDir, "heartbeat-runner.runtime-fspOEj_1.js"),
      "old runtime\n",
    );
    await fsPromises.writeFile(path.join(distRuntimeDir, "heartbeat-runner.runtime.js"), "alias\n");

    pruneStaleRootChunkFiles({ cwd: rootDir });

    await expect(
      fsPromises.readFile(path.join(distDir, "compact.runtime.js"), "utf8"),
    ).resolves.toBe("stable alias\n");
    await expect(fsPromises.readFile(path.join(distDir, "entry.js"), "utf8")).resolves.toBe(
      "entry\n",
    );
    await expect(
      fsPromises.readFile(path.join(distDir, "control-ui", "index.html"), "utf8"),
    ).resolves.toBe("asset\n");
    await expect(
      fsPromises.readFile(path.join(distRuntimeDir, "heartbeat-runner.runtime.js"), "utf8"),
    ).resolves.toBe("alias\n");
    await expectPathMissing(path.join(distDir, "delegate-BPjCe4gC.js"));
    await expectPathMissing(path.join(distDir, "compact.runtime-2DiEmVcA.js"));
    await expectPathMissing(path.join(distRuntimeDir, "heartbeat-runner.runtime-fspOEj_1.js"));
  });

  it("cleans tsdown output roots before using tsdown --no-clean", async () => {
    const rootDir = createTempDir("openclaw-tsdown-clean-");
    const distFile = path.join(rootDir, "dist", "stale.js");
    const pluginGeneratedFile = path.join(rootDir, "dist", "extensions", "telegram", "index.js");
    const distRuntimeFile = path.join(rootDir, "dist-runtime", "stale.js");
    const agentCorePackageFile = path.join(rootDir, "packages", "agent-core", "dist", "stale.js");
    const netPolicyPackageFile = path.join(rootDir, "packages", "net-policy", "dist", "stale.js");
    const pluginSdkPackageFile = path.join(rootDir, "packages", "plugin-sdk", "dist", "keep.js");
    const packageSourceFile = path.join(rootDir, "packages", "agent-core", "src", "keep.ts");
    const unrelatedFile = path.join(rootDir, "tmp", "keep.js");
    await fsPromises.mkdir(path.dirname(distFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(pluginGeneratedFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(distRuntimeFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(agentCorePackageFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(netPolicyPackageFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(pluginSdkPackageFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(packageSourceFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(unrelatedFile), { recursive: true });
    await fsPromises.writeFile(distFile, "stale\n");
    await fsPromises.writeFile(pluginGeneratedFile, "generated\n");
    await fsPromises.writeFile(distRuntimeFile, "stale\n");
    await fsPromises.writeFile(agentCorePackageFile, "stale\n");
    await fsPromises.writeFile(netPolicyPackageFile, "stale\n");
    await fsPromises.writeFile(pluginSdkPackageFile, "keep\n");
    await fsPromises.writeFile(packageSourceFile, "keep\n");
    await fsPromises.writeFile(unrelatedFile, "keep\n");

    const outputRoots = listTsdownOutputRoots();
    expect(outputRoots).toEqual(
      expect.arrayContaining(["packages/agent-core/dist", "packages/net-policy/dist"]),
    );
    expect(outputRoots).not.toContain(path.join("packages", "plugin-sdk", "dist"));

    cleanTsdownOutputRoots({ cwd: rootDir });

    await expectPathMissing(distFile);
    await expectPathMissing(pluginGeneratedFile);
    await expectPathMissing(path.join(rootDir, "dist-runtime"));
    await expectPathMissing(path.join(rootDir, "packages", "agent-core", "dist"));
    await expectPathMissing(path.join(rootDir, "packages", "net-policy", "dist"));
    await expect(fsPromises.readFile(pluginSdkPackageFile, "utf8")).resolves.toBe("keep\n");
    await expect(fsPromises.readFile(packageSourceFile, "utf8")).resolves.toBe("keep\n");
    await expect(fsPromises.readFile(unrelatedFile, "utf8")).resolves.toBe("keep\n");
  });

  it("removes CLI startup metadata during default tsdown clean", async () => {
    const rootDir = createTempDir("openclaw-tsdown-clean-metadata-default-");
    const metadataFile = path.join(rootDir, "dist", "cli-startup-metadata.json");
    await fsPromises.mkdir(path.dirname(metadataFile), { recursive: true });
    await fsPromises.writeFile(metadataFile, '{"generatedBy":"test"}\n');

    cleanTsdownOutputRoots({ cwd: rootDir });

    await expectPathMissing(metadataFile);
  });

  it("preserves CLI startup metadata across opted-in build-all tsdown clean", async () => {
    const rootDir = createTempDir("openclaw-tsdown-clean-metadata-");
    const metadataFile = path.join(rootDir, "dist", "cli-startup-metadata.json");
    const staleFile = path.join(rootDir, "dist", "stale.js");
    const nestedStaleFile = path.join(rootDir, "dist", "nested", "stale.js");
    await fsPromises.mkdir(path.dirname(nestedStaleFile), { recursive: true });
    await fsPromises.writeFile(metadataFile, '{"generatedBy":"test"}\n');
    await fsPromises.writeFile(staleFile, "stale\n");
    await fsPromises.writeFile(nestedStaleFile, "stale\n");

    cleanTsdownOutputRoots({
      cwd: rootDir,
      env: { OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1" },
    });

    await expect(fsPromises.readFile(metadataFile, "utf8")).resolves.toBe(
      '{"generatedBy":"test"}\n',
    );
    await expectPathMissing(staleFile);
    await expectPathMissing(nestedStaleFile);
  });

  it("preserves existing package declarations when tsdown DTS output is skipped", async () => {
    const rootDir = createTempDir("openclaw-tsdown-clean-skip-dts-");
    const declarationFile = path.join(
      rootDir,
      "packages",
      "media-understanding-common",
      "dist",
      "index.d.mts",
    );
    const nestedDeclarationFile = path.join(
      rootDir,
      "packages",
      "media-understanding-common",
      "dist",
      "nested",
      "types.d.ts",
    );
    const staleJsFile = path.join(
      rootDir,
      "packages",
      "media-understanding-common",
      "dist",
      "index.mjs",
    );
    const nestedStaleFile = path.join(
      rootDir,
      "packages",
      "media-understanding-common",
      "dist",
      "chunks",
      "old.js",
    );
    const agentCorePackageFile = path.join(rootDir, "packages", "agent-core", "dist", "stale.js");
    await fsPromises.mkdir(path.dirname(declarationFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(nestedDeclarationFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(nestedStaleFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(agentCorePackageFile), { recursive: true });
    await fsPromises.writeFile(declarationFile, "export {};\n");
    await fsPromises.writeFile(nestedDeclarationFile, "export {};\n");
    await fsPromises.writeFile(staleJsFile, "stale\n");
    await fsPromises.writeFile(nestedStaleFile, "old\n");
    await fsPromises.writeFile(agentCorePackageFile, "stale\n");

    cleanTsdownOutputRoots({
      cwd: rootDir,
      env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
    });

    await expect(fsPromises.readFile(declarationFile, "utf8")).resolves.toBe("export {};\n");
    await expect(fsPromises.readFile(nestedDeclarationFile, "utf8")).resolves.toBe("export {};\n");
    await expectPathMissing(staleJsFile);
    await expectPathMissing(nestedStaleFile);
    await expectPathMissing(path.join(rootDir, "packages", "agent-core", "dist"));
  });

  it("prunes untracked generated declaration files that shadow source entries", async () => {
    const rootDir = createTempDir("openclaw-tsdown-source-dts-");
    const signalDir = path.join(rootDir, "extensions", "signal");
    const signalSrcDir = path.join(signalDir, "src");
    await fsPromises.mkdir(signalSrcDir, { recursive: true });
    await fsPromises.writeFile(path.join(signalDir, "api.ts"), "export {};\n");
    await fsPromises.writeFile(path.join(signalDir, "api.d.ts"), "export {};\n");
    await fsPromises.writeFile(path.join(signalSrcDir, "probe.ts"), "export {};\n");
    await fsPromises.writeFile(path.join(signalSrcDir, "probe.d.ts"), "export {};\n");
    await fsPromises.writeFile(
      path.join(signalSrcDir, "ambient.d.ts"),
      "declare const x: string;\n",
    );

    const removed = pruneUntrackedGeneratedSourceDeclarations({
      cwd: rootDir,
      spawnSync: () => ({
        status: 0,
        stdout:
          "extensions/signal/api.d.ts\nextensions/signal/src/probe.d.ts\nextensions/signal/src/ambient.d.ts\n",
      }),
    });

    expect(removed).toBe(2);
    await expectPathMissing(path.join(signalDir, "api.d.ts"));
    await expectPathMissing(path.join(signalSrcDir, "probe.d.ts"));
    await expect(
      fsPromises.readFile(path.join(signalSrcDir, "ambient.d.ts"), "utf8"),
    ).resolves.toBe("declare const x: string;\n");
  });
});

describe("createTsdownOutputScanner", () => {
  it("tracks fatal build diagnostics while bounding captured output", () => {
    const scanner = createTsdownOutputScanner({ maxCaptureBytes: 20 });

    scanner.append("prefix that should be trimmed\n");
    scanner.append("[INEFFECTIVE_DYNAMIC_IMPORT]\n");
    scanner.append("[UNRESOLVED_IMPORT] src/index.ts\n");

    const result = scanner.finish();

    expect(result.hasIneffectiveDynamicImport).toBe(true);
    expect(result.fatalUnresolvedImport).toContain("[UNRESOLVED_IMPORT] src/index.ts");
    expect(result.captured.length).toBeLessThanOrEqual(20);
  });

  it("ignores unresolved imports from bundled plugin and dependency paths", () => {
    const scanner = createTsdownOutputScanner();

    scanner.append("[UNRESOLVED_IMPORT] extensions/telegram/src/index.ts\n");
    scanner.append("[UNRESOLVED_IMPORT] node_modules/example/index.js\n");
    scanner.append(
      "[UNRESOLVED_IMPORT] ../../../../tmp/openclaw-pnpm-node-modules/baileys/lib/Utils/messages-media.js\n",
    );

    expect(scanner.finish().fatalUnresolvedImport).toBeNull();
  });
});

describe("runTsdownBuildInvocation", () => {
  function createWriteSink() {
    const chunks: string[] = [];
    return {
      sink: {
        write(chunk: unknown) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
          return true;
        },
      },
      chunks,
    };
  }

  it("streams child output while preserving diagnostics for post-run checks", async () => {
    const output = createWriteSink();
    const result = await runTsdownBuildInvocation(
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('stdout-ok\\n'); process.stderr.write('[INEFFECTIVE_DYNAMIC_IMPORT]\\n')",
        ],
        options: {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          env: process.env,
        },
      },
      {
        stdout: output.sink,
        stderr: output.sink,
        env: { ...process.env, OPENCLAW_TSDOWN_HEARTBEAT_MS: "0" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.hasIneffectiveDynamicImport).toBe(true);
    expect(output.chunks.join("")).toContain("stdout-ok");
  });

  it("rejects malformed OPENCLAW_TSDOWN_TIMEOUT_MS values", async () => {
    const invocation = {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: process.env,
      },
    };

    for (const value of ["1.5", "1e3", "10ms", "0"]) {
      await expect(
        runTsdownBuildInvocation(invocation, {
          env: {
            ...process.env,
            OPENCLAW_TSDOWN_TIMEOUT_MS: value,
          },
        }),
      ).rejects.toThrow("OPENCLAW_TSDOWN_TIMEOUT_MS must be");
    }
  });

  it("rejects malformed OPENCLAW_TSDOWN_HEARTBEAT_MS values", async () => {
    const invocation = {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: process.env,
      },
    };

    for (const value of ["1.5", "1e3", "10ms", "-1"]) {
      await expect(
        runTsdownBuildInvocation(invocation, {
          env: {
            ...process.env,
            OPENCLAW_TSDOWN_HEARTBEAT_MS: value,
          },
        }),
      ).rejects.toThrow("OPENCLAW_TSDOWN_HEARTBEAT_MS must be");
    }
  });

  it("terminates the child when OPENCLAW_TSDOWN_TIMEOUT_MS elapses", async () => {
    const output = createWriteSink();
    const result = await runTsdownBuildInvocation(
      {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        options: {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          env: process.env,
        },
      },
      {
        stdout: output.sink,
        stderr: output.sink,
        env: {
          ...process.env,
          OPENCLAW_TSDOWN_HEARTBEAT_MS: "0",
          OPENCLAW_TSDOWN_TIMEOUT_MS: "50",
        },
      },
    );

    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(output.chunks.join("")).toContain("timeout after 50ms");
  });

  it("signals Windows tsdown process trees with taskkill", () => {
    const childKill = vi.fn(() => true);
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    signalTsdownBuildProcessTree({ pid: 123, kill: childKill }, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(1, expectedTaskkillPath(), ["/PID", "123", "/T"], {
      stdio: "ignore",
    });

    signalTsdownBuildProcessTree({ pid: 123, kill: childKill }, "SIGKILL", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "123", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(childKill).not.toHaveBeenCalled();
  });

  it("force-kills Windows tsdown process trees when graceful taskkill fails", () => {
    const childKill = vi.fn(() => true);
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    signalTsdownBuildProcessTree({ pid: 123, kill: childKill }, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });

    expect(runTaskkill).toHaveBeenNthCalledWith(1, expectedTaskkillPath(), ["/PID", "123", "/T"], {
      stdio: "ignore",
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "123", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(childKill).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "kills timed-out tsdown process groups when the wrapper exits first",
    async () => {
      const rootDir = createTempDir("openclaw-tsdown-timeout-");
      const childPidPath = path.join(rootDir, "child.pid");
      const timeoutMs = 250;
      let childPid: number | undefined;
      const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("");

      try {
        const output = createWriteSink();
        const runPromise = runTsdownBuildInvocation(
          {
            command: process.execPath,
            args: ["-e", parentScript],
            options: {
              stdio: ["ignore", "pipe", "pipe"],
              shell: false,
              env: process.env,
            },
          },
          {
            stdout: output.sink,
            stderr: output.sink,
            env: {
              ...process.env,
              OPENCLAW_TSDOWN_HEARTBEAT_MS: "0",
              OPENCLAW_TSDOWN_TIMEOUT_MS: String(timeoutMs),
            },
          },
        );

        await waitForFile(childPidPath, timeoutMs);
        childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
        expect(isProcessAlive(childPid)).toBe(true);
        const result = await runPromise;

        expect(result.timedOut).toBe(true);
        await waitForDead(childPid, 2_000);
      } finally {
        if (childPid !== undefined && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves timeout grace when descendant processes exit cleanly",
    async () => {
      const rootDir = createTempDir("openclaw-tsdown-timeout-clean-");
      const readyPath = path.join(rootDir, "child.ready");
      const cleanupPath = path.join(rootDir, "child.cleanup");
      const childPidPath = path.join(rootDir, "child.pid");
      const childScript = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        `    fs.writeFileSync(${JSON.stringify(cleanupPath)}, 'clean');`,
        "    process.exit(0);",
        "  }, 50);",
        "});",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "setInterval(() => {}, 1000);",
      ].join("");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("");
      let childPid = 0;

      try {
        const output = createWriteSink();
        const startedAt = Date.now();
        const runPromise = runTsdownBuildInvocation(
          {
            command: process.execPath,
            args: ["-e", parentScript],
            options: {
              stdio: ["ignore", "pipe", "pipe"],
              shell: false,
              env: process.env,
            },
          },
          {
            stdout: output.sink,
            stderr: output.sink,
            env: {
              ...process.env,
              OPENCLAW_TSDOWN_HEARTBEAT_MS: "0",
              OPENCLAW_TSDOWN_TIMEOUT_MS: "250",
            },
          },
        );

        await waitForFile(readyPath, 2_000);
        childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
        const result = await runPromise;

        expect(result.timedOut).toBe(true);
        expect(fs.readFileSync(cleanupPath, "utf8")).toBe("clean");
        expect(Date.now() - startedAt).toBeLessThan(900);
        await waitForDead(childPid, 2_000);
      } finally {
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans process-group descendants before forwarding parent SIGTERM",
    async () => {
      const rootDir = createTempDir("openclaw-tsdown-parent-signal-");
      const childPidPath = path.join(rootDir, "child.pid");
      const readyPath = path.join(rootDir, "child.ready");
      const scriptUrl = pathToFileURL(path.resolve("scripts/tsdown-build.mjs")).href;
      let childPid = 0;
      let runner: ReturnType<typeof spawn> | undefined;

      try {
        const childScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");
        const runnerScript = [
          `import { runTsdownBuildInvocation } from ${JSON.stringify(scriptUrl)};`,
          "await runTsdownBuildInvocation(",
          `  { command: process.execPath, args: ['-e', ${JSON.stringify(parentScript)}], options: { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: process.env } },`,
          "  { env: { ...process.env, OPENCLAW_TSDOWN_HEARTBEAT_MS: '0' } },",
          ");",
        ].join("\n");

        runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
        });

        await waitForFile(readyPath, 2_000);
        await waitForFile(childPidPath, 2_000);
        childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
        expect(isProcessAlive(childPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(waitForChildClose(runner)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitForDead(childPid, 2_000);
      } finally {
        if (runner?.pid && isProcessAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );
});
