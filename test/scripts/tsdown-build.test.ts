import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanTsdownOutputRoots,
  createTsdownOutputScanner,
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

  it("preserves inherited lower tsdown heap settings", () => {
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=4096" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=4096");
  });

  it("preserves split inherited lower tsdown heap settings", () => {
    const result = resolveTsdownBuildInvocation({
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size 4096" },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=4096");
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
    const unrelatedFile = path.join(rootDir, "tmp", "keep.js");
    await fsPromises.mkdir(path.dirname(distFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(pluginGeneratedFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(distRuntimeFile), { recursive: true });
    await fsPromises.mkdir(path.dirname(unrelatedFile), { recursive: true });
    await fsPromises.writeFile(distFile, "stale\n");
    await fsPromises.writeFile(pluginGeneratedFile, "generated\n");
    await fsPromises.writeFile(distRuntimeFile, "stale\n");
    await fsPromises.writeFile(unrelatedFile, "keep\n");

    cleanTsdownOutputRoots({ cwd: rootDir });

    await expectPathMissing(distFile);
    await expectPathMissing(pluginGeneratedFile);
    await expectPathMissing(path.join(rootDir, "dist-runtime"));
    await expect(fsPromises.readFile(unrelatedFile, "utf8")).resolves.toBe("keep\n");
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
