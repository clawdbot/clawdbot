import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanTsdownOutputRoots,
  createTsdownOutputScanner,
  listTsdownOutputRoots,
  parseTsdownBuildArgs,
  pruneSourceCheckoutBundledPluginNodeModules,
  pruneStaleRootChunkFiles,
  pruneUntrackedGeneratedSourceDeclarations,
  resolveTsdownBuildInvocation,
  runTsdownBuildInvocation,
} from "../../scripts/tsdown-build.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const NO_MEMORY_LIMIT = {
  cgroupMemoryLimitPaths: [],
  procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
};

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
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(result.args).toContain("tsdown");
    expect(result.args).toEqual(expect.arrayContaining(["--config-loader", "unrun", "--no-clean"]));
    expect(result.args.slice(-2)).toEqual(["--format", "esm"]);
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

  it("preserves explicit tsdown heap settings", () => {
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=8192" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=8192");
  });

  it("raises inherited lower tsdown heap settings to the build default", () => {
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=4096" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=8192");
  });

  it("raises split inherited lower tsdown heap settings to the build default", () => {
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size 4096" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=8192");
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
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=8192" },
      cgroupMemoryLimitBytes: 7 * 1024 * 1024 * 1024,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=6400");
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
          NODE_OPTIONS: "--max-old-space-size=8192",
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
      expect.arrayContaining([
        path.join("packages", "agent-core", "dist"),
        path.join("packages", "net-policy", "dist"),
      ]),
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
});
