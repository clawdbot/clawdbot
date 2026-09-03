// Tests node process runner lifecycle and captured output.
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  bundledDistPluginFile,
  bundledPluginFile,
  bundledPluginRoot,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it as baseIt, vi } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  acquireRunNodeBuildLock,
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
  runNodeMain,
} from "../../scripts/run-node.mts";
import { withTestDir } from "../test-helpers/temp-dir.js";

const it = baseIt.extend<{ tmp: string }>({
  tmp: async ({ task: _task }, use) => {
    await withTestDir({ prefix: "openclaw-run-node-" }, use);
  },
});

const ROOT_SRC = "src/index.ts";
const ROOT_TSCONFIG = "tsconfig.json";
const ROOT_PACKAGE = "package.json";
const ROOT_TSDOWN = "tsdown.config.ts";
const RUNTIME_POSTBUILD_IMPLEMENTATION_PATHS = [
  "scripts/check-built-plugin-control-plane-modules.mts",
  "scripts/copy-bundled-plugin-metadata.mts",
  "scripts/copy-hook-metadata.ts",
  "scripts/runtime-postbuild.mts",
  "scripts/stage-bundled-plugin-runtime.mts",
  "scripts/write-build-info.ts",
  "scripts/write-official-channel-catalog.mts",
] as const;
const DEPLOYMENT_MANIFEST = "deployment.json";
const GENERATED_PLUGIN_ASSET_BUNDLE = "extensions/demo/src/host/assets/view.bundle.js";
const GENERATED_PLUGIN_ASSET_BUNDLE_HASH = "extensions/demo/src/host/assets/.bundle.hash";
const DIST_ENTRY = "dist/entry.js";
const BUILD_STAMP = `dist/${BUILD_STAMP_FILE}`;
const RUNTIME_POSTBUILD_STAMP = `dist/${RUNTIME_POSTBUILD_STAMP_FILE}`;
const DIST_PLUGIN_SDK_CORE = "dist/plugin-sdk/core.js";
const DIST_CHANNEL_CATALOG = "dist/channel-catalog.json";
const DIST_BUILD_INFO = "dist/build-info.json";
const DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT = "dist/shared-Y6bNiw2w.js";
const DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT = "dist/shared-DTaQo6Hi.js";
const DIST_LEGACY_CLI_EXIT_COMPAT = "dist/memory-state-CcqRgDZU.js";
const DIST_LEGACY_CLI_EXIT_COMPAT_ALT = "dist/memory-state-DwGdReW4.js";
const DIST_STABLE_ROOT_RUNTIME_SOURCE = "dist/model-catalog.runtime-AbCd1234.js";
const DIST_STABLE_ROOT_RUNTIME_SOURCE_ALT = "dist/model-catalog.runtime-EfGh5678.js";
const DIST_STABLE_ROOT_RUNTIME_ALIAS = "dist/model-catalog.runtime.js";
const DIST_LEGACY_ROOT_RUNTIME_TARGET = "dist/abort.runtime.js";
const DIST_LEGACY_ROOT_RUNTIME_COMPAT = "dist/abort.runtime-DX6vo4yJ.js";
const QA_LAB_PLUGIN_SDK_ENTRY = "dist/plugin-sdk/qa-lab.js";
const QA_RUNTIME_PLUGIN_SDK_ENTRY = "dist/plugin-sdk/qa-runtime.js";
const EXTENSION_INDEX = bundledPluginFile("demo", "index.ts");
const EXTENSION_SRC = bundledPluginFile("demo", "src/index.ts");
const EXTENSION_EXTRA_SRC = bundledPluginFile("demo", "src/extra.ts");
const EXTENSION_SKILL = bundledPluginFile("demo", "skills/SKILL.md");
const EXTENSION_MANIFEST = bundledPluginFile("demo", "openclaw.plugin.json");
const EXTENSION_PACKAGE = bundledPluginFile("demo", "package.json");
const EXTENSION_README = bundledPluginFile("demo", "README.md");
const DIST_EXTENSION_INDEX = bundledDistPluginFile("demo", "index.js");
const DIST_EXTENSION_SRC = bundledDistPluginFile("demo", "src/index.js");
const DIST_EXTENSION_SKILL = bundledDistPluginFile("demo", "skills/SKILL.md");
const DIST_EXTENSION_RUNTIME_SRC = "dist-runtime/extensions/demo/src/index.js";
const DIST_RUNTIME_EXTENSION_INDEX = "dist-runtime/extensions/demo/index.js";
const DIST_RUNTIME_EXTENSION_MANIFEST = "dist-runtime/extensions/demo/openclaw.plugin.json";
const DIST_RUNTIME_EXTENSION_PACKAGE = "dist-runtime/extensions/demo/package.json";
const DIST_RUNTIME_EXTENSION_SKILL = "dist-runtime/extensions/demo/skills/SKILL.md";
const DIST_OPENCLAW_ALIAS_PACKAGE = "dist/extensions/node_modules/openclaw/package.json";
const DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE =
  "dist/extensions/node_modules/openclaw/plugin-sdk/core.js";
const DIST_OPENCLAW_ALIAS_PLUGIN_SDK_STRING_COERCE =
  "dist/extensions/node_modules/openclaw/plugin-sdk/string-coerce-runtime.js";
const DIFFS_PACKAGE = "extensions/diffs/package.json";
const DIFFS_VIEWER_RUNTIME_SOURCE = "extensions/diffs/assets/viewer-runtime.js";
const DIST_DIFFS_VIEWER_RUNTIME = "dist/extensions/diffs/assets/viewer-runtime.js";
const DIST_RUNTIME_DIFFS_VIEWER_RUNTIME = "dist-runtime/extensions/diffs/assets/viewer-runtime.js";
const BUNDLED_HOOK_METADATA = "src/hooks/bundled/demo/HOOK.md";
const DIST_BUNDLED_HOOK_METADATA = "dist/bundled/demo/HOOK.md";
const DIST_EXTENSION_MANIFEST = bundledDistPluginFile("demo", "openclaw.plugin.json");
const DIST_EXTENSION_PACKAGE = bundledDistPluginFile("demo", "package.json");

const OLD_TIME = new Date("2026-03-13T10:00:00.000Z");
const BUILD_TIME = new Date("2026-03-13T12:00:00.000Z");
const NEW_TIME = new Date("2026-03-13T12:00:01.000Z");

const BASE_PROJECT_FILES = {
  [ROOT_TSCONFIG]: "{}\n",
  [ROOT_PACKAGE]: '{"name":"openclaw-test"}\n',
  [DIST_ENTRY]: "console.log('built');\n",
  [BUILD_STAMP]: '{"head":"abc123"}\n',
} as const;

function createExitedProcess(code: number | null, signal: string | null = null) {
  return {
    on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === "exit") {
        queueMicrotask(() => cb(code, signal));
      }
      return undefined;
    },
  };
}

function createPipedExitedProcess(params: {
  code?: number | null;
  signal?: string | null;
  stderr?: string;
  stdout?: string;
}) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return {
    stdout,
    stderr,
    on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === "exit") {
        queueMicrotask(() => {
          if (params.stdout) {
            stdout.emit("data", Buffer.from(params.stdout));
          }
          if (params.stderr) {
            stderr.emit("data", Buffer.from(params.stderr));
          }
          cb(params.code ?? 0, params.signal ?? null);
        });
      }
      return undefined;
    },
  };
}

function createFakeProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    execPath: process.execPath,
  }) as unknown as NodeJS.Process;
}

// Launcher plumbing tests do not need the real runtime artifact copier.
async function skipRuntimePostBuild(): Promise<void> {}

async function syncBundledPluginMetadata(params?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  copyBundledPluginMetadata({ cwd: params?.cwd, env: params?.env });
}

function firstMockCall<T extends unknown[]>(mock: { mock: { calls: T[] } }): T | undefined {
  return mock.mock.calls[0];
}

async function writeRuntimePostBuildScaffold(tmp: string): Promise<void> {
  await fs.mkdir(path.join(tmp, "extensions"), { recursive: true });
  await writeProjectFiles(tmp, {
    [DIST_PLUGIN_SDK_CORE]: "export const core = true;\n",
    [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
    [DIST_BUILD_INFO]: '{"buildId":"test-build"}\n',
    [DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT]: "export function resolveNodeRunner() {}\n",
    [DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT]: "export function resolveNodeRunner() {}\n",
    [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
    [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]: "export function hasMemoryRuntime() { return false; }\n",
    [DIST_OPENCLAW_ALIAS_PACKAGE]:
      '{"name":"openclaw","type":"module","exports":{"./plugin-sdk/core":"./plugin-sdk/core.js"}}\n',
    [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE]: "export * from '../../../../plugin-sdk/core.js';\n",
  });
  await touchProjectFiles(
    tmp,
    [
      DIST_CHANNEL_CATALOG,
      DIST_BUILD_INFO,
      DIST_PLUGIN_SDK_CORE,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT,
      DIST_LEGACY_CLI_EXIT_COMPAT,
      DIST_LEGACY_CLI_EXIT_COMPAT_ALT,
      DIST_OPENCLAW_ALIAS_PACKAGE,
      DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE,
    ],
    BUILD_TIME,
  );
}

function expectedBuildSpawn() {
  return [process.execPath, "--import", "tsx", "scripts/build-all.mts", "qaRuntime"];
}

function statusCommandSpawn() {
  return [process.execPath, "openclaw.mjs", "status"];
}

function gatewayStatusCommandSpawn() {
  return [
    process.execPath,
    "openclaw.mjs",
    "gateway",
    "status",
    "--deep",
    "--require-rpc",
    "--json",
  ];
}

function resolvePath(tmp: string, relativePath: string) {
  return path.join(tmp, relativePath);
}

function isTsxScriptArgs(args: string[], scriptPath: string): boolean {
  return args[0] === "--import" && args[1] === "tsx" && args[2] === scriptPath;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let accessError: unknown;
  try {
    await fs.access(targetPath);
  } catch (error) {
    accessError = error;
  }
  expect((accessError as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
}

async function writeProjectFiles(tmp: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const absolutePath = resolvePath(tmp, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, contents, "utf-8");
    }),
  );
}

async function touchProjectFiles(tmp: string, relativePaths: string[], time: Date) {
  await Promise.all(
    relativePaths.map(async (relativePath) => {
      const absolutePath = resolvePath(tmp, relativePath);
      await fs.utimes(absolutePath, time, time);
    }),
  );
}

async function setupTrackedProject(
  tmp: string,
  options: {
    files?: Record<string, string>;
    oldPaths?: string[];
    buildPaths?: string[];
    newPaths?: string[];
  } = {},
) {
  await writeRuntimePostBuildScaffold(tmp);
  await writeProjectFiles(tmp, {
    ...BASE_PROJECT_FILES,
    ...options.files,
  });
  await touchProjectFiles(tmp, options.oldPaths ?? [], OLD_TIME);
  await touchProjectFiles(tmp, options.buildPaths ?? [], BUILD_TIME);
  await touchProjectFiles(tmp, options.newPaths ?? [], NEW_TIME);
}

async function setupStampedProject(
  tmp: string,
  options: {
    files?: Record<string, string>;
    oldPaths?: string[];
    newPaths?: string[];
    rootSource?: boolean;
    trackConfig?: boolean;
  },
): Promise<void> {
  const files = {
    ...(options.rootSource === false ? {} : { [ROOT_SRC]: "export const value = 1;\n" }),
    ...options.files,
  };
  const excludedPaths = new Set([...(options.oldPaths ?? []), ...(options.newPaths ?? [])]);
  const buildPaths = [
    ...Object.keys(files).filter((filePath) => !excludedPaths.has(filePath)),
    ...(options.trackConfig ? [ROOT_TSCONFIG, ROOT_PACKAGE] : []),
    DIST_ENTRY,
    BUILD_STAMP,
  ];
  await setupTrackedProject(tmp, {
    files,
    ...(options.oldPaths ? { oldPaths: options.oldPaths } : {}),
    buildPaths,
    ...(options.newPaths ? { newPaths: options.newPaths } : {}),
  });
}

async function writeImmutableDeploymentManifest(tmp: string): Promise<void> {
  await writeProjectFiles(tmp, {
    [DEPLOYMENT_MANIFEST]: `${JSON.stringify({ kind: "git", sourceHead: "a".repeat(40) })}\n`,
  });
}

function createSpawnRecorder(
  options: {
    gitHead?: string;
    gitStatus?: string;
  } = {},
) {
  const spawnCalls: string[][] = [];
  const spawn = (cmd: string, args: string[]) => {
    spawnCalls.push([cmd, ...args]);
    return createExitedProcess(0);
  };
  const spawnSync = (cmd: string, args: string[]) => {
    if (cmd === "git" && args[0] === "rev-parse" && options.gitHead !== undefined) {
      return { status: 0, stdout: options.gitHead };
    }
    if (cmd === "git" && args[0] === "status" && options.gitStatus !== undefined) {
      return { status: 0, stdout: options.gitStatus };
    }
    return { status: 1, stdout: "" };
  };
  return { spawnCalls, spawn, spawnSync };
}

function createCurrentGitSpawnRecorder(options: { gitHead?: string; gitStatus?: string } = {}) {
  return createSpawnRecorder({ gitHead: "abc123\n", gitStatus: "", ...options });
}

function createBuildRequirementDeps(
  tmp: string,
  options: {
    gitStatus?: string;
    env?: Record<string, string>;
  } = {},
) {
  const { spawnSync } = createCurrentGitSpawnRecorder({ gitStatus: options.gitStatus ?? "" });
  return {
    cwd: tmp,
    env: {
      ...process.env,
      ...options.env,
    },
    fs: fsSync,
    spawnSync,
    distRoot: path.join(tmp, "dist"),
    distEntry: path.join(tmp, DIST_ENTRY),
    buildStampPath: path.join(tmp, BUILD_STAMP),
    runtimePostBuildStampPath: path.join(tmp, RUNTIME_POSTBUILD_STAMP),
    sourceRoots: [path.join(tmp, "src"), path.join(tmp, bundledPluginRoot("demo"))].map(
      (sourceRoot) => ({
        name: path.relative(tmp, sourceRoot).replaceAll("\\", "/"),
        path: sourceRoot,
      }),
    ),
    configFiles: [ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN].map((filePath) =>
      path.join(tmp, filePath),
    ),
  };
}

type RunNodeTestOptions = NonNullable<Parameters<typeof runNodeMain>[0]> & {
  stdout?: NodeJS.WriteStream;
};

async function runNodeCommand(tmp: string, options: RunNodeTestOptions): Promise<number> {
  const { env, ...overrides } = options;
  return await runNodeMain({
    cwd: tmp,
    args: ["status"],
    ...overrides,
    env: { ...process.env, OPENCLAW_RUNNER_LOG: "0", ...env },
    execPath: process.execPath,
    platform: options.platform ?? process.platform,
  } as RunNodeTestOptions);
}

type RunCommandParams = {
  tmp: string;
  args?: string[];
  spawn: (cmd: string, args: string[]) => ReturnType<typeof createExitedProcess>;
  spawnSync?: (cmd: string, args: string[]) => { status: number; stdout: string };
  stderr?: NodeJS.WriteStream;
  env?: Record<string, string>;
  runRuntimePostBuild?: (params?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  }) => void | Promise<void>;
};

async function runStatusCommand({ tmp, ...options }: RunCommandParams): Promise<number> {
  return await runNodeCommand(tmp, options);
}

async function runQaCommand(params: RunCommandParams): Promise<number> {
  return await runStatusCommand({
    ...params,
    args: ["qa", "suite", "--transport", "qa-channel", "--provider-mode", "mock-openai"],
  });
}

async function expectManifestId(tmp: string, relativePath: string, id: string) {
  const manifest = JSON.parse(await fs.readFile(resolvePath(tmp, relativePath), "utf-8")) as {
    id?: unknown;
  };
  expect(manifest.id).toBe(id);
}

describe("run-node script", () => {
  it("starts the CLI only after the canonical runtime build completes", async ({ tmp }) => {
    const build = new EventEmitter();
    const spawn = vi.fn((_cmd: string, args: string[]) =>
      isTsxScriptArgs(args, "scripts/build-all.mts") ? build : createExitedProcess(0),
    );
    const runRuntimePostBuild = vi.fn();
    const result = runNodeCommand(tmp, {
      spawn,
      env: { OPENCLAW_FORCE_BUILD: "1" },
      runRuntimePostBuild,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
    expect(fsSync.existsSync(lockDir)).toBe(true);
    build.emit("exit", 0, null);

    expect(await result).toBe(0);
    expect(spawn.mock.calls.map(([cmd, args]) => [cmd].concat(args))).toEqual([
      expectedBuildSpawn(),
      statusCommandSpawn(),
    ]);
    // The canonical profile owns metadata and both stamps; the local runner
    // only invokes postbuild directly on its separate metadata-only path.
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
    expect(fsSync.existsSync(lockDir)).toBe(false);
  });

  it.for([undefined, "0", "1"])(
    "defaults DTS off only for the canonical build child (override: %s)",
    async (skipDts, { tmp }) => {
      const spawnCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
      const spawn = (_cmd: string, args: string[], options: SpawnOptions) => {
        spawnCalls.push({ args, env: { ...options.env } });
        return createExitedProcess(0);
      };
      const exitCode = await runNodeCommand(tmp, {
        env: { OPENCLAW_FORCE_BUILD: "1", OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: skipDts },
        spawn,
      });
      expect(exitCode).toBe(0);
      expect(spawnCalls.map(({ args }) => args)).toEqual([
        expectedBuildSpawn().slice(1),
        ["openclaw.mjs", "status"],
      ]);
      expect(spawnCalls[0]?.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(skipDts ?? "1");
      expect(spawnCalls[1]?.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(skipDts);
    },
  );

  it("tees launcher output into the requested generic output log", async ({ tmp }) => {
    await setupTrackedProject(tmp);
    const outputPath = path.join(tmp, ".artifacts", "qa-e2e", "matrix", "output.log");
    const spawnCalls: Array<{
      args: string[];
      env: Record<string, string | undefined>;
      stdio: unknown;
    }> = [];
    const spawn = (_cmd: string, args: string[], options?: unknown) => {
      const opts = options as { env?: NodeJS.ProcessEnv; stdio?: unknown } | undefined;
      spawnCalls.push({
        args,
        env: { ...opts?.env },
        stdio: opts?.stdio,
      });
      return createPipedExitedProcess({
        stdout: args[0] === "openclaw.mjs" ? "child stdout\n" : "",
        stderr: args[0] === "openclaw.mjs" ? "child stderr\n" : "",
      });
    };
    const mutedStream = {
      write: () => true,
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      env: {
        OPENCLAW_FORCE_BUILD: "1",
        OPENCLAW_RUNNER_LOG: "1",
        OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath,
      },
      spawn,
      stderr: mutedStream,
      stdout: mutedStream,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain("child stdout\n");
    await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain("child stderr\n");
    await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain("[openclaw]");
    expect(spawnCalls.at(-1)?.args).toEqual(["openclaw.mjs", "status"]);
    expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_OUTPUT_LOG).toBe(outputPath);
    expect(spawnCalls.at(-1)?.stdio).toEqual(["inherit", "pipe", "pipe"]);
  });

  it("routes local build stdout to stderr before JSON command output", async ({ tmp }) => {
    await writeRuntimePostBuildScaffold(tmp);
    const outputPath = path.join(tmp, ".artifacts", "run-node", "output.log");
    const spawn = (_cmd: string, args: string[]) => {
      if (isTsxScriptArgs(args, "scripts/build-all.mts")) {
        return createPipedExitedProcess({
          stdout: "asset stdout\nbuild stdout\n",
          stderr: "asset stderr\nbuild stderr\n",
        });
      }
      return createPipedExitedProcess({ stdout: '{"plugins":[]}\n' });
    };
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout = {
      write: (chunk: string | Buffer) => {
        stdoutChunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const stderr = {
      write: (chunk: string | Buffer) => {
        stderrChunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      args: ["plugins", "list", "--json"],
      env: { OPENCLAW_FORCE_BUILD: "1", OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath },
      spawn,
      stdout,
      stderr,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(stdoutChunks.join("")).toBe('{"plugins":[]}\n');
    expect(stderrChunks.join("")).toContain("asset stdout\n");
    expect(stderrChunks.join("")).toContain("asset stderr\n");
    expect(stderrChunks.join("")).toContain("build stdout\n");
    expect(stderrChunks.join("")).toContain("build stderr\n");
  });

  it("routes sync I/O trace stderr blocks to the output log without flooding stderr", async ({
    tmp,
  }) => {
    await setupTrackedProject(tmp);
    const outputPath = path.join(tmp, ".artifacts", "gateway-watch-profiles", "output.log");
    const childStderr = [
      "normal before\n",
      "(node:12345) WARNING: Detected use of sync API\n",
      "    at statSync (node:fs:1739:25)\n",
      "    at loadConfig (/repo/src/config.ts:1:1)\n",
      "\n",
      "normal after\n",
    ].join("");
    const spawn = (_cmd: string, args: string[]) =>
      createPipedExitedProcess({
        stderr: args[0] === "openclaw.mjs" ? childStderr : "",
      });
    const stderrChunks: string[] = [];
    const stderr = {
      write: (chunk: string | Buffer) => {
        stderrChunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const stdout = {
      write: () => true,
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      env: {
        OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR: "1",
        OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath,
      },
      spawn,
      stderr,
      stdout,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    const terminalStderr = stderrChunks.join("");
    expect(terminalStderr).toContain("normal before\n");
    expect(terminalStderr).toContain("normal after\n");
    expect(terminalStderr).not.toContain("Detected use of sync API");
    expect(terminalStderr).not.toContain("statSync");
    await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain(childStderr);
  });

  it("adds Node CPU profiling flags to the launched OpenClaw child when requested", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
        [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
        [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]: "export function hasMemoryRuntime() { return false; }\n",
      },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    const profileDir = path.join(tmp, ".artifacts", "profiles");
    const spawnCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const spawn = (_cmd: string, args: string[], options?: unknown) => {
      const opts = options as { env?: NodeJS.ProcessEnv } | undefined;
      spawnCalls.push({ args, env: { ...opts?.env } });
      return createExitedProcess(0);
    };
    const { spawnSync } = createCurrentGitSpawnRecorder();

    const exitCode = await runNodeCommand(tmp, {
      env: { OPENCLAW_RUN_NODE_CPU_PROF_DIR: ".artifacts/profiles" },
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
      process: createFakeProcess(),
    });

    expect(exitCode).toBe(0);
    const childArgs = spawnCalls.at(-1)?.args ?? [];
    expect(childArgs[0]).toBe("--cpu-prof");
    expect(childArgs[1]).toBe(`--cpu-prof-dir=${profileDir}`);
    expect(childArgs[2]).toMatch(
      /^--cpu-prof-name=openclaw-status-4242-\d{4}-\d{2}-\d{2}T.*\.cpuprofile$/,
    );
    expect(childArgs.slice(3)).toEqual(["openclaw.mjs", "status"]);
    expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_CPU_PROF_DIR).toBe(profileDir);
    expect(fsSync.existsSync(profileDir)).toBe(true);
  });

  it("rotates old Node CPU profiles when a retention cap is set", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
    const profileDir = path.join(tmp, ".artifacts", "profiles");
    fsSync.mkdirSync(profileDir, { recursive: true });
    const oldProfiles = [
      "openclaw-status-oldest.cpuprofile",
      "openclaw-status-middle.cpuprofile",
      "openclaw-status-newest.cpuprofile",
    ];
    for (const [index, name] of oldProfiles.entries()) {
      const filePath = path.join(profileDir, name);
      fsSync.writeFileSync(filePath, "{}");
      const mtime = new Date(1_700_000_000_000 + index * 1000);
      fsSync.utimesSync(filePath, mtime, mtime);
    }
    fsSync.writeFileSync(path.join(profileDir, "openclaw-models-old.cpuprofile"), "{}");

    const spawn = () => createExitedProcess(0);
    const { spawnSync } = createCurrentGitSpawnRecorder();

    const exitCode = await runNodeCommand(tmp, {
      env: {
        OPENCLAW_RUN_NODE_CPU_PROF_DIR: ".artifacts/profiles",
        OPENCLAW_RUN_NODE_CPU_PROF_MAX_FILES: "2",
      },
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
      process: createFakeProcess(),
    });

    expect(exitCode).toBe(0);
    expect(
      fsSync.existsSync(
        path.join(profileDir, expectDefined(oldProfiles[0], "oldProfiles[0] test invariant")),
      ),
    ).toBe(false);
    expect(
      fsSync.existsSync(
        path.join(profileDir, expectDefined(oldProfiles[1], "oldProfiles[1] test invariant")),
      ),
    ).toBe(false);
    expect(
      fsSync.existsSync(
        path.join(profileDir, expectDefined(oldProfiles[2], "oldProfiles[2] test invariant")),
      ),
    ).toBe(true);
    expect(fsSync.existsSync(path.join(profileDir, "openclaw-models-old.cpuprofile"))).toBe(true);
  });

  it("adds Node sync I/O tracing flag to the launched OpenClaw child when requested", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
    const spawnCalls: string[][] = [];
    const spawn = (_cmd: string, args: string[]) => {
      spawnCalls.push(args);
      return createExitedProcess(0);
    };
    const { spawnSync } = createCurrentGitSpawnRecorder();

    const exitCode = await runNodeCommand(tmp, {
      args: ["gateway", "--force"],
      env: { OPENCLAW_TRACE_SYNC_IO: "1" },
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls.at(-1)).toEqual(["--trace-sync-io", "openclaw.mjs", "gateway", "--force"]);
  });

  it("surfaces generic output log stream errors", async ({ tmp }) => {
    await setupTrackedProject(tmp);
    const outputPath = path.join(tmp, ".artifacts", "qa-e2e", "matrix", "output.log");
    await fs.mkdir(outputPath, { recursive: true });
    const spawn = () => createPipedExitedProcess({ stdout: "child stdout\n" });
    const stderrChunks: string[] = [];
    const mutedStream = {
      write: (chunk: string | Buffer) => {
        stderrChunks.push(String(chunk));
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      env: { OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath },
      spawn,
      stderr: mutedStream,
      stdout: mutedStream,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain("Failed to write output log");
  });

  it("does not mutate Matrix QA args when no generic output log is requested", async ({ tmp }) => {
    await setupTrackedProject(tmp);
    const spawnCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    const spawn = (_cmd: string, args: string[], options?: unknown) => {
      const opts = options as { env?: NodeJS.ProcessEnv } | undefined;
      spawnCalls.push({ args, env: { ...opts?.env } });
      return createPipedExitedProcess({});
    };
    const mutedStream = {
      write: () => true,
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      args: ["qa", "matrix"],
      spawn,
      stderr: mutedStream,
      stdout: mutedStream,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    const childArgs = spawnCalls.at(-1)?.args ?? [];
    expect(childArgs).toEqual(["openclaw.mjs", "qa", "matrix"]);
    expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_OUTPUT_LOG).toBeUndefined();
  });

  it("skips rebuilding when dist is current and the source tree is clean", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
  });

  it.for([undefined, "/explicit/checkout"])(
    "carries the checkout selector into the CLI (override: %s)",
    async (override, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
      const { spawnSync } = createCurrentGitSpawnRecorder();
      let childEnv: NodeJS.ProcessEnv | undefined;
      const exitCode = await runNodeCommand(tmp, {
        env: { OPENCLAW_DEV_SOURCE_ROOT: override },
        spawn: (_cmd, _args, options) => {
          childEnv = options.env;
          return createExitedProcess(0);
        },
        spawnSync,
        runRuntimePostBuild: skipRuntimePostBuild,
      });
      expect(exitCode).toBe(0);
      expect(childEnv?.OPENCLAW_DEV_SOURCE_ROOT).toBe(override ?? tmp);
    },
  );

  it("skips rebuilding for private QA commands when the private QA facades are present", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n",
        [QA_RUNTIME_PLUGIN_SDK_ENTRY]: "export const qaRuntime = true;\n",
      },
      oldPaths: [
        ROOT_SRC,
        ROOT_TSCONFIG,
        ROOT_PACKAGE,
        QA_LAB_PLUGIN_SDK_ENTRY,
        QA_RUNTIME_PLUGIN_SDK_ENTRY,
      ],
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runQaCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([
      [
        process.execPath,
        "openclaw.mjs",
        "qa",
        "suite",
        "--transport",
        "qa-channel",
        "--provider-mode",
        "mock-openai",
      ],
    ]);
  });

  it("rebuilds private QA commands when the private QA runtime facade is missing", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n" },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, QA_LAB_PLUGIN_SDK_ENTRY],
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runQaCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([
      expectedBuildSpawn(),
      [
        process.execPath,
        "openclaw.mjs",
        "qa",
        "suite",
        "--transport",
        "qa-channel",
        "--provider-mode",
        "mock-openai",
      ],
    ]);
  });

  it.for([
    { mode: "build", disable: undefined },
    { mode: "build", disable: "1" },
    { mode: "metadata", disable: undefined },
    { mode: "metadata", disable: "1" },
  ])(
    "carries private QA policy through $mode (disable: $disable)",
    async ({ mode, disable }, { tmp }) => {
      await setupStampedProject(tmp, {
        files: {
          [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n",
          ...(mode === "metadata"
            ? { [QA_RUNTIME_PLUGIN_SDK_ENTRY]: "export const qaRuntime = true;\n" }
            : {}),
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      });
      const runRuntimePostBuild = vi.fn();
      const spawn = vi.fn((_cmd: string, _args: string[], _options: SpawnOptions) =>
        createExitedProcess(0),
      );
      const { spawnSync } = createCurrentGitSpawnRecorder();
      const exitCode = await runNodeCommand(tmp, {
        args: ["qa", "suite"],
        spawn,
        spawnSync,
        runRuntimePostBuild,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: disable },
      });
      expect(exitCode).toBe(0);
      expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
        ...(mode === "build" ? [expectedBuildSpawn().slice(1)] : []),
        ["openclaw.mjs", "qa", "suite"],
      ]);
      const expectedEnv = {
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: disable ?? "0",
      };
      for (const call of spawn.mock.calls) {
        expect(call[2].env).toMatchObject(expectedEnv);
      }
      if (mode === "metadata") {
        expect(runRuntimePostBuild).toHaveBeenCalledExactlyOnceWith({
          cwd: tmp,
          env: expect.objectContaining(expectedEnv),
        });
      } else {
        expect(runRuntimePostBuild).not.toHaveBeenCalled();
      }
    },
  );

  it("derives private QA facade checks from distRoot for direct freshness checks", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n" },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, QA_LAB_PLUGIN_SDK_ENTRY],
    });

    const requirement = resolveBuildRequirement(
      createBuildRequirementDeps(tmp, { env: { OPENCLAW_BUILD_PRIVATE_QA: "1" } }),
    );

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "missing_private_qa_dist",
    });
  });

  it("skips runtime postbuild restaging in watch mode when dist is already current", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      env: { OPENCLAW_WATCH_MODE: "1" },
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  it("reruns runtime postbuild in watch mode when required outputs are missing with no runtime stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
        [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]: "export function hasMemoryRuntime() { return false; }\n",
      },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    await fs.rm(resolvePath(tmp, DIST_OPENCLAW_ALIAS_PACKAGE));

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      env: { OPENCLAW_WATCH_MODE: "1" },
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
  });

  it("reruns runtime postbuild for dirty extension package metadata in watch mode", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.ts"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
      trackConfig: true,
    });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_PACKAGE}\n`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      env: { OPENCLAW_WATCH_MODE: "1" },
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
  });

  for (const { title, command, reportScript, reportArgs } of [
    {
      title: "runs QA parity report from source without rebuilding private QA dist",
      command: "parity-report",
      reportScript: "qa-parity-report.ts",
      reportArgs: [
        "--candidate-summary",
        ".artifacts/qa-e2e/openai-candidate/qa-suite-summary.json",
        "--baseline-summary",
        ".artifacts/qa-e2e/anthropic-baseline/qa-suite-summary.json",
      ],
    },
    {
      title: "runs QA coverage report from source without rebuilding private QA dist",
      command: "coverage",
      reportScript: "qa-coverage-report.ts",
      reportArgs: [
        "--json",
        "--tools",
        "--summary",
        ".artifacts/qa-e2e/runtime-pair-core/qa-suite-summary.json",
      ],
    },
  ]) {
    it(title, async ({ tmp }) => {
      await setupTrackedProject(tmp, {
        files: { "extensions/qa-lab/src/cli.runtime.ts": "export {};\n" },
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });
      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };
      const exitCode = await runNodeCommand(tmp, {
        args: ["qa", command, ...reportArgs],
        spawn,
      });
      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        [
          process.execPath,
          "--import",
          "tsx",
          path.join(tmp, "scripts", reportScript),
          ...reportArgs,
        ],
      ]);
    });
  }

  it("skips runtime postbuild restaging when the runtime stamp is current", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n' },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  it("runs current immutable deployment artifacts without refreshing them", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n' },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    await writeImmutableDeploymentManifest(tmp);

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      args: ["gateway", "status", "--deep", "--require-rpc", "--json"],
      spawn,
      spawnSync,
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([gatewayStatusCommandSpawn()]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  for (const { label, missingPath, expectedReason } of [
    {
      label: "build output",
      missingPath: BUILD_STAMP,
      expectedReason: "build stamp missing",
    },
    {
      label: "runtime postbuild output",
      missingPath: DIST_OPENCLAW_ALIAS_PACKAGE,
      expectedReason: "required runtime postbuild output missing",
    },
  ]) {
    it(`refuses to regenerate missing ${label} in an immutable deployment`, async ({ tmp }) => {
      await setupStampedProject(tmp, {
        files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n' },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      });
      await writeImmutableDeploymentManifest(tmp);
      await fs.rm(resolvePath(tmp, missingPath));

      const stderrChunks: string[] = [];
      const stderr = {
        write: (chunk: string | Buffer) => {
          stderrChunks.push(String(chunk));
          return true;
        },
      } as unknown as NodeJS.WriteStream;
      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
      const exitCode = await runStatusCommand({
        tmp,
        args: ["gateway", "status", "--deep", "--require-rpc", "--json"],
        spawn,
        spawnSync,
        stderr,
        runRuntimePostBuild,
      });

      expect(exitCode).toBe(1);
      expect(spawnCalls).toEqual([]);
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
      expect(stderrChunks.join("")).toContain(expectedReason);
      expect(stderrChunks.join("")).toContain("node openclaw.mjs");
    });
  }

  it("restages runtime artifacts when runtime metadata is dirty", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
      trackConfig: true,
    });

    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_MANIFEST}\n`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    expect(runRuntimePostBuild).toHaveBeenCalledOnce();
  });

  it("serializes runtime postbuild restaging across concurrent clean launchers", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    let activePostbuilds = 0;
    let maxActivePostbuilds = 0;
    let markPostbuildStarted!: () => void;
    let releasePostbuild!: () => void;
    const postbuildStarted = new Promise<void>((resolve) => {
      markPostbuildStarted = resolve;
    });
    const postbuildRelease = new Promise<void>((resolve) => {
      releasePostbuild = resolve;
    });
    const runRuntimePostBuild = vi.fn(async () => {
      activePostbuilds += 1;
      maxActivePostbuilds = Math.max(maxActivePostbuilds, activePostbuilds);
      markPostbuildStarted();
      await postbuildRelease;
      activePostbuilds -= 1;
    });
    const { spawn, spawnSync } = createCurrentGitSpawnRecorder();

    const runs = Promise.all([
      runStatusCommand({
        tmp,
        spawn,
        spawnSync,
        env: {
          OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS: "1",
        },
        runRuntimePostBuild,
      }),
      runStatusCommand({
        tmp,
        spawn,
        spawnSync,
        env: {
          OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS: "1",
        },
        runRuntimePostBuild,
      }),
    ]);

    await postbuildStarted;
    releasePostbuild();
    await expect(runs).resolves.toEqual([0, 0]);

    expect(runRuntimePostBuild).toHaveBeenCalledTimes(1);
    expect(maxActivePostbuilds).toBe(1);
    expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
  });

  it("returns the canonical build failure without starting the CLI", async ({ tmp }) => {
    const spawn = vi.fn((cmd: string, args: string[] = []) => {
      if (cmd === process.execPath && isTsxScriptArgs(args, "scripts/build-all.mts")) {
        return createExitedProcess(23);
      }
      return createExitedProcess(0);
    });

    const exitCode = await runNodeCommand(tmp, { env: { OPENCLAW_FORCE_BUILD: "1" }, spawn });

    expect(exitCode).toBe(23);
    expect(spawn).toHaveBeenCalledOnce();
    expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
  });

  it("returns failure and releases the build lock when the canonical build spawn errors", async ({
    tmp,
  }) => {
    const spawn = vi.fn((cmd: string, args: string[] = []) => {
      if (cmd === process.execPath && isTsxScriptArgs(args, "scripts/build-all.mts")) {
        const events = new EventEmitter();
        queueMicrotask(() => events.emit("error", new Error("spawn failed")));
        return {
          on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
            events.on(event, cb);
            return undefined;
          },
        };
      }
      return createExitedProcess(0);
    });

    const exitCode = await runNodeCommand(tmp, { env: { OPENCLAW_FORCE_BUILD: "1" }, spawn });

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
  });

  it.for([false, true])(
    "forwards SIGTERM to the active child and returns 143 (rebuild: %s)",
    async (rebuild, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

      const fakeProcess = Object.assign(createFakeProcess(), {
        stdin: {
          isTTY: true,
        },
      });
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn((signal: string) => {
          queueMicrotask(() => child.emit("exit", 0, null));
          return signal;
        }),
      });
      const spawn = vi.fn<
        (
          cmd: string,
          args: string[],
          options: unknown,
        ) => {
          kill: (signal?: string) => boolean;
          on: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void;
        }
      >(() => ({
        kill: (signal) => {
          child.kill(signal ?? "SIGTERM");
          return true;
        },
        on: (event, cb) => {
          child.on(event, cb);
        },
      }));

      const exitCodePromise = runNodeCommand(tmp, {
        env: { OPENCLAW_FORCE_BUILD: rebuild ? "1" : "0" },
        process: fakeProcess,
        spawn,
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      await vi.waitFor(() => {
        expect(spawn).toHaveBeenCalled();
      });
      fakeProcess.emit("SIGTERM");
      const exitCode = await exitCodePromise;

      expect(exitCode).toBe(143);
      expect(spawn).toHaveBeenCalledTimes(1);
      const spawnCall = firstMockCall(spawn) as [string, string[], { stdio?: unknown }] | undefined;
      expect(spawnCall?.[0]).toBe(process.execPath);
      expect(spawnCall?.[1]).toEqual(
        rebuild ? expectedBuildSpawn().slice(1) : ["openclaw.mjs", "status"],
      );
      expect(spawnCall?.[2].stdio).toEqual(rebuild ? ["inherit", "pipe", "pipe"] : "inherit");
      expect(spawnCall?.[2]).toMatchObject({ detached: false });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
      expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32").for([false, true])(
    "force-cleans the active child process group after SIGTERM (rebuild: %s)",
    async (rebuild, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

      const fakeProcess = Object.assign(createFakeProcess(), {
        stdin: {
          isTTY: false,
        },
      });
      const child = Object.assign(new EventEmitter(), {
        pid: 42_420,
        kill: vi.fn(),
      });
      const groupSignals: Array<[number, string | number]> = [];
      const spawn = vi.fn<
        (
          cmd: string,
          args: string[],
          options: unknown,
        ) => {
          kill: (signal?: string) => boolean;
          on: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void;
          pid: number;
        }
      >(() => ({
        kill: (signal) => {
          child.kill(signal ?? "SIGTERM");
          return true;
        },
        on: (event, cb) => {
          child.on(event, cb);
        },
        pid: child.pid,
      }));

      const exitCodePromise = runNodeCommand(tmp, {
        env: { OPENCLAW_FORCE_BUILD: rebuild ? "1" : "0" },
        platform: "darwin",
        process: fakeProcess,
        signalProcess: (pid: number, signal?: string | number) => {
          groupSignals.push([pid, signal ?? "SIGTERM"]);
          if (signal === "SIGTERM") {
            queueMicrotask(() => child.emit("exit", 0, null));
          }
          return true;
        },
        spawn,
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      await vi.waitFor(() => {
        expect(spawn).toHaveBeenCalled();
      });
      fakeProcess.emit("SIGTERM");
      const exitCode = await exitCodePromise;

      expect(exitCode).toBe(143);
      const spawnCall = firstMockCall(spawn) as
        | [string, string[], { detached?: boolean; stdio?: unknown }]
        | undefined;
      expect(spawnCall?.[1]).toEqual(
        rebuild ? expectedBuildSpawn().slice(1) : ["openclaw.mjs", "status"],
      );
      expect(spawnCall?.[2]).toMatchObject({
        detached: true,
        stdio: rebuild ? ["inherit", "pipe", "pipe"] : "inherit",
      });
      expect(spawn).toHaveBeenCalledOnce();
      expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
      expect(groupSignals).toEqual([
        [-42_420, "SIGTERM"],
        [-42_420, "SIGKILL"],
      ]);
      expect(child.kill).not.toHaveBeenCalled();
      expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it("rebuilds when extension sources are newer than the build stamp", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_SRC]: "export const extensionValue = 1;\n",
      },
      newPaths: [EXTENSION_SRC],
      rootSource: false,
      trackConfig: true,
    });

    const { spawnCalls, spawn, spawnSync } = createSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);
  });

  it("shows tty progress while rebuilding source-checkout artifacts", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
    const { spawn, spawnSync } = createSpawnRecorder();
    const stderrChunks: string[] = [];
    const stderr = {
      isTTY: true,
      write: vi.fn((chunk: string | Buffer) => {
        stderrChunks.push(String(chunk));
        return true;
      }),
    } as unknown as NodeJS.WriteStream;

    const exitCode = await runNodeCommand(tmp, {
      env: { CI: "false", OPENCLAW_FORCE_BUILD: "1" },
      spawn,
      spawnSync,
      stderr,
      runRuntimePostBuild: async () => {},
    });

    expect(exitCode).toBe(0);
    const stderrText = stderrChunks.join("");
    expect(stderrText).toContain("Building local CLI artifacts");
    expect(stderrText).toContain("\x1b[2K");
  });

  it("rebuilds when git HEAD changes even if source mtimes do not exceed the old build stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({ gitHead: "def456\n" });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);
  });

  it("skips rebuilding when extension package metadata is newer than the build stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]: '{"name":"demo","openclaw":{"extensions":["./index.ts"]}}\n',
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_PACKAGE]: '{"name":"demo","openclaw":{"extensions":["./stale.js"]}}\n',
      },
      oldPaths: [EXTENSION_INDEX, EXTENSION_MANIFEST, ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
      newPaths: [EXTENSION_PACKAGE],
      rootSource: false,
    });

    const { spawnCalls, spawn, spawnSync } = createSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expect(fs.readFile(resolvePath(tmp, DIST_EXTENSION_PACKAGE), "utf-8")).resolves.toContain(
      '"./index.js"',
    );
  });

  it("skips rebuilding for dirty non-source files under extensions", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [EXTENSION_README]: "# demo\n", [ROOT_TSDOWN]: "export default {};\n" },
      trackConfig: true,
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_README}\n`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
  });

  it("skips rebuilding for dirty extension manifests that only affect runtime reload", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"stale","configSchema":{"type":"object"}}\n',
      },
      trackConfig: true,
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${EXTENSION_MANIFEST}\n`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expectManifestId(tmp, DIST_EXTENSION_MANIFEST, "demo");
  });

  it("reports dirty watched source trees as an explicit build reason", async ({ tmp }) => {
    await setupStampedProject(tmp, { trackConfig: true });

    const requirement = resolveBuildRequirement(
      createBuildRequirementDeps(tmp, { gitStatus: ` M ${ROOT_SRC}\n` }),
    );

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "dirty_watched_tree",
    });
  });

  it.each([
    { label: "gateway RPC", args: ["gateway", "call", "status", "--json"] },
    { label: "gateway status", args: ["gateway", "status", "--json"] },
    { label: "remote agent", args: ["agent", "--message", "hello"] },
    { label: "dashboard", args: ["dashboard", "--no-open", "--yes"] },
  ])("does not rebuild for $label calls against an existing dirty dist", async ({ args }) => {
    await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupStampedProject(tmp, {
        files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n' },
        trackConfig: true,
      });

      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
        gitStatus: ` M ${ROOT_SRC}\n`,
      });
      const exitCode = await runStatusCommand({
        tmp,
        args,
        spawn,
        spawnSync,
        runRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([[process.execPath, "openclaw.mjs", ...args]]);
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
    });
  });

  it("rechecks a dirty dashboard client after waiting for an active build", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n' },
      trackConfig: true,
    });
    await fs.rm(resolvePath(tmp, BUILD_STAMP));
    await fs.rm(resolvePath(tmp, RUNTIME_POSTBUILD_STAMP));

    const lockProcess = Object.assign(createFakeProcess(), {
      kill: vi.fn(() => true),
    }) as unknown as NodeJS.Process;
    const releaseLock = await acquireRunNodeBuildLock({
      cwd: tmp,
      args: ["gateway"],
      env: { OPENCLAW_RUNNER_LOG: "0" },
      fs: fsSync,
      process: lockProcess,
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    });
    let markWaiting!: () => void;
    const waitingForLock = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    const stderr = {
      write: (chunk: string | Buffer) => {
        if (String(chunk).includes("Waiting for TypeScript/runtime artifact lock")) {
          markWaiting();
        }
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${ROOT_SRC}\n`,
    });
    const clientRun = runNodeCommand(tmp, {
      args: ["dashboard", "--no-open", "--yes"],
      env: { OPENCLAW_RUNNER_LOG: "1", OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS: "1" },
      spawn,
      spawnSync,
      process: lockProcess,
      stderr,
      runRuntimePostBuild,
    });

    await waitingForLock;
    await fs.writeFile(resolvePath(tmp, BUILD_STAMP), '{"head":"abc123"}\n', "utf-8");
    await fs.writeFile(resolvePath(tmp, RUNTIME_POSTBUILD_STAMP), '{"head":"abc123"}\n', "utf-8");
    releaseLock();

    await expect(clientRun).resolves.toBe(0);
    expect(spawnCalls).toEqual([
      [process.execPath, "openclaw.mjs", "dashboard", "--no-open", "--yes"],
    ]);
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  it("reports a clean tree explicitly when dist is current", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

  it("ignores newer tracked config mtimes when Git proves the checkout is clean", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [ROOT_TSDOWN]: "export default {};\n" },
      oldPaths: [ROOT_SRC],
      newPaths: [ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
    });

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

  it("uses newer config mtimes when Git state is unavailable", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      oldPaths: [ROOT_SRC],
      newPaths: [ROOT_TSCONFIG, ROOT_PACKAGE],
    });
    const { spawnSync } = createSpawnRecorder();

    const requirement = resolveBuildRequirement({
      ...createBuildRequirementDeps(tmp),
      spawnSync,
    });

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "config_newer",
    });
  });

  it("reports clean in sparse worktrees without bundled plugin sources", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
    await fs.rm(resolvePath(tmp, "extensions"), { recursive: true, force: true });

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

  it("rebuilds when dirty bundled package entries point at missing dist outputs", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_SRC]: "export default {};\n",
        [EXTENSION_EXTRA_SRC]: "export const extra = true;\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts","./src/extra.ts"]}}\n',
        [DIST_EXTENSION_SRC]: "export default {};\n",
      },
      trackConfig: true,
    });

    const requirement = resolveBuildRequirement(
      createBuildRequirementDeps(tmp, { gitStatus: ` M ${EXTENSION_PACKAGE}\n` }),
    );

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "dirty_watched_tree",
    });
  });

  it("rebuilds when clean bundled plugin dist outputs are partially missing", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_SRC]: "export default {};\n",
        [EXTENSION_EXTRA_SRC]: "export const extra = true;\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts","./src/extra.ts"]}}\n',
        [DIST_EXTENSION_SRC]: "export default {};\n",
      },
      trackConfig: true,
    });

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "missing_bundled_plugin_dist_entry",
    });
  });

  it("rebuilds when a clean stamped bundled plugin dist directory is missing", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_SRC]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts"]}}\n',
      },
      trackConfig: true,
    });

    const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldBuild: true,
      reason: "missing_bundled_plugin_dist_entry",
    });
  });

  it("reports clean runtime postbuild artifacts when the runtime stamp matches HEAD", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n' },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing runtime postbuild outputs even when stamps match HEAD", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_SRC]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts"]}}\n',
        [DIST_EXTENSION_SRC]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.js"]}}\n',
        [DIST_EXTENSION_RUNTIME_SRC]: "export default {};\n",
        [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.js"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });
    await fs.rm(resolvePath(tmp, DIST_EXTENSION_PACKAGE));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("reports missing runtime overlay outputs from restored dist without plugin sources", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
        [DIST_RUNTIME_EXTENSION_INDEX]: "export default {};\n",
        [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });
    await fs.rm(resolvePath(tmp, "extensions"), { recursive: true, force: true });
    await fs.rm(resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("does not require OpenClaw SDK alias outputs when dist extensions are absent", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_PLUGIN_SDK_CORE]: "export const core = true;\n",
        [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
        [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
        [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]: "export function hasMemoryRuntime() { return false; }\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });
    await fs.rm(path.join(tmp, "dist", "extensions"), { recursive: true, force: true });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing OpenClaw SDK alias outputs when runtime stamps match HEAD", async ({
    tmp,
  }) => {
    await setupTrackedProject(tmp, {
      files: {
        [ROOT_SRC]: "export const value = 1;\n",
        [ROOT_PACKAGE]:
          '{"name":"openclaw-test","exports":{"./plugin-sdk/core":"./dist/plugin-sdk/core.js"}}\n',
        [DIST_PLUGIN_SDK_CORE]: "export const core = true;\n",
        [DIST_OPENCLAW_ALIAS_PACKAGE]:
          '{"name":"openclaw","type":"module","exports":{"./plugin-sdk/core":"./plugin-sdk/core.js"}}\n',
        [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE]: "export * from '../../../../plugin-sdk/core.js';\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
      buildPaths: [
        ROOT_SRC,
        DIST_ENTRY,
        DIST_PLUGIN_SDK_CORE,
        DIST_OPENCLAW_ALIAS_PACKAGE,
        DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE,
        BUILD_STAMP,
        RUNTIME_POSTBUILD_STAMP,
      ],
    });
    await fs.rm(resolvePath(tmp, DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("does not require private OpenClaw SDK dist files that package exports omit", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [ROOT_PACKAGE]: JSON.stringify(
          {
            name: "openclaw-test",
            exports: {
              "./plugin-sdk/string-coerce-runtime": "./dist/plugin-sdk/string-coerce-runtime.js",
            },
          },
          null,
          2,
        ),
        "dist/plugin-sdk/string-coerce-runtime.js": "export const publicRuntime = true;\n",
        "dist/plugin-sdk/ssrf-runtime-internal.js": "export const internal = true;\n",
        [DIST_OPENCLAW_ALIAS_PACKAGE]:
          '{"name":"openclaw","type":"module","exports":{"./plugin-sdk/string-coerce-runtime":"./plugin-sdk/string-coerce-runtime.js"}}\n',
        [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_STRING_COERCE]:
          "export * from '../../../../plugin-sdk/string-coerce-runtime.js';\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  for (const [title, missingPath] of [
    [
      "reports missing static runtime postbuild asset outputs when runtime stamps match HEAD",
      DIST_DIFFS_VIEWER_RUNTIME,
    ],
    [
      "reports missing static runtime overlay asset outputs when runtime stamps match HEAD",
      DIST_RUNTIME_DIFFS_VIEWER_RUNTIME,
    ],
  ] as const) {
    it(title, async ({ tmp }) => {
      await setupStampedProject(tmp, {
        files: {
          [DIFFS_PACKAGE]:
            '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
          [DIFFS_VIEWER_RUNTIME_SOURCE]: "export {};\n",
          [DIST_DIFFS_VIEWER_RUNTIME]: "export {};\n",
          [DIST_RUNTIME_DIFFS_VIEWER_RUNTIME]: "export {};\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
      });
      await fs.rm(resolvePath(tmp, missingPath));
      const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));
      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
    });
  }

  it("does not require static asset outputs when runtime static assets are disabled", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIFFS_PACKAGE]:
          '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
        [DIFFS_VIEWER_RUNTIME_SOURCE]: "export {};\n",
        [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(
      createBuildRequirementDeps(tmp, { env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" } }),
    );

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("does not require static asset outputs when the declared source is absent", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIFFS_PACKAGE]:
          '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing core runtime postbuild outputs when runtime stamps match HEAD", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_STABLE_ROOT_RUNTIME_SOURCE]: "export const value = 1;\n",
        [DIST_STABLE_ROOT_RUNTIME_ALIAS]: "export * from './model-catalog.runtime-AbCd1234.js';\n",
        [DIST_LEGACY_ROOT_RUNTIME_TARGET]: "export const aborted = true;\n",
        [DIST_LEGACY_ROOT_RUNTIME_COMPAT]: "export * from './abort.runtime.js';\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });

    for (const missingPath of [
      DIST_CHANNEL_CATALOG,
      DIST_BUILD_INFO,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT,
      DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT,
      DIST_LEGACY_CLI_EXIT_COMPAT,
      DIST_STABLE_ROOT_RUNTIME_ALIAS,
      DIST_LEGACY_ROOT_RUNTIME_COMPAT,
    ]) {
      const resolvedMissingPath = resolvePath(tmp, missingPath);
      const originalContent = await fs.readFile(resolvedMissingPath, "utf8");
      await fs.rm(resolvedMissingPath);
      const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
      await fs.writeFile(resolvedMissingPath, originalContent);
    }
  });

  it("reports missing bundled hook metadata when runtime stamps match HEAD", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [BUNDLED_HOOK_METADATA]: "# Demo hook\n",
        [DIST_BUNDLED_HOOK_METADATA]: "# Demo hook\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });

    expect(resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp))).toEqual({
      shouldSync: false,
      reason: "clean",
    });
    await fs.rm(resolvePath(tmp, DIST_BUNDLED_HOOK_METADATA));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("does not require ambiguous stable runtime aliases that postbuild cannot create", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: {
        [DIST_STABLE_ROOT_RUNTIME_SOURCE]: "export const value = 1;\n",
        [DIST_STABLE_ROOT_RUNTIME_SOURCE_ALT]: "export const value = 2;\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: false,
      reason: "clean",
    });
  });

  it("reports missing runtime skill outputs even when stamps match HEAD", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [EXTENSION_SKILL]: "# Demo\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [DIST_EXTENSION_SKILL]: "# Demo\n",
        [DIST_RUNTIME_EXTENSION_INDEX]: "export default {};\n",
        [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [DIST_RUNTIME_EXTENSION_SKILL]: "# Demo\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
    });
    await fs.rm(resolvePath(tmp, DIST_RUNTIME_EXTENSION_SKILL));

    const requirement = resolveRuntimePostBuildRequirement(createBuildRequirementDeps(tmp));

    expect(requirement).toEqual({
      shouldSync: true,
      reason: "missing_runtime_postbuild_output",
    });
  });

  it("reports dirty runtime postbuild inputs separately from rebuild inputs", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        [DIST_EXTENSION_INDEX]: "export default {};\n",
      },
      trackConfig: true,
    });

    const deps = createBuildRequirementDeps(tmp, { gitStatus: ` M ${EXTENSION_MANIFEST}\n` });

    expect(resolveBuildRequirement(deps)).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
    expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
      shouldSync: true,
      reason: "dirty_runtime_postbuild_inputs",
    });
  });

  it.each(RUNTIME_POSTBUILD_IMPLEMENTATION_PATHS)(
    "reports dirty runtime postbuild implementation %s",
    async (implementationPath) => {
      await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        await setupStampedProject(tmp, {
          files: {
            [implementationPath]: "export {};\n",
            [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
          },
          trackConfig: true,
        });

        const requirement = resolveRuntimePostBuildRequirement(
          createBuildRequirementDeps(tmp, { gitStatus: ` M ${implementationPath}\n` }),
        );

        expect(requirement).toEqual({
          shouldSync: true,
          reason: "dirty_runtime_postbuild_inputs",
        });
      });
    },
  );

  it("reports a newer hook metadata copier without git status", async ({ tmp }) => {
    const implementationPath = "scripts/copy-hook-metadata.ts";
    await setupStampedProject(tmp, {
      files: {
        [implementationPath]: "export {};\n",
        [RUNTIME_POSTBUILD_STAMP]: "{}\n",
      },
      newPaths: [implementationPath],
      trackConfig: true,
    });
    const deps = createBuildRequirementDeps(tmp);
    deps.spawnSync = () => ({ status: 1, stdout: "" });

    expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
      shouldSync: true,
      reason: "runtime_postbuild_input_mtime_newer",
    });
  });

  it("ignores dirty generated plugin bundle artifacts when dist is current", async ({ tmp }) => {
    await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

    const requirement = resolveBuildRequirement(
      createBuildRequirementDeps(tmp, {
        gitStatus: ` M ${GENERATED_PLUGIN_ASSET_BUNDLE_HASH}\n M ${GENERATED_PLUGIN_ASSET_BUNDLE}\n`,
      }),
    );

    expect(requirement).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

  it("reports bundled skill edits as runtime postbuild inputs", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
        [EXTENSION_SKILL]: "# Demo\n",
        [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
      },
      trackConfig: true,
    });

    const deps = createBuildRequirementDeps(tmp, { gitStatus: ` M ${EXTENSION_SKILL}\n` });

    expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
      shouldSync: true,
      reason: "dirty_runtime_postbuild_inputs",
    });
  });

  it("repairs missing bundled plugin metadata without rerunning tsdown", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [EXTENSION_INDEX]: "export default {};\n",
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_INDEX]: "export default {};\n",
      },
      trackConfig: true,
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expectManifestId(tmp, DIST_EXTENSION_MANIFEST, "demo");
  });

  it("removes stale bundled plugin metadata when the source manifest is gone", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: {
        [ROOT_TSDOWN]: "export default {};\n",
        [DIST_EXTENSION_MANIFEST]: '{"id":"stale","configSchema":{"type":"object"}}\n',
        [DIST_EXTENSION_PACKAGE]: '{"name":"stale"}\n',
      },
      trackConfig: true,
    });

    await fs.mkdir(resolvePath(tmp, bundledPluginRoot("demo")), { recursive: true });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: syncBundledPluginMetadata,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
    await expectPathMissing(resolvePath(tmp, DIST_EXTENSION_MANIFEST));
    await expectPathMissing(resolvePath(tmp, DIST_EXTENSION_PACKAGE));
  });

  it("skips rebuilding when only non-source extension files are newer than the build stamp", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [EXTENSION_README]: "# demo\n", [ROOT_TSDOWN]: "export default {};\n" },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
      newPaths: [EXTENSION_README],
    });

    const { spawnCalls, spawn, spawnSync } = createSpawnRecorder();
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([statusCommandSpawn()]);
  });

  it("rebuilds when tsdown config is dirty", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [ROOT_TSDOWN]: "export default {};\n" },
      oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      newPaths: [ROOT_TSDOWN],
    });

    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${ROOT_TSDOWN}\n`,
    });
    const exitCode = await runStatusCommand({
      tmp,
      spawn,
      spawnSync,
      runRuntimePostBuild: skipRuntimePostBuild,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);
  });

  describe("acquireRunNodeBuildLock", () => {
    const lockDeps = (tmp: string, fakeProcess: NodeJS.Process) => ({
      cwd: tmp,
      args: ["status"],
      env: { OPENCLAW_RUNNER_LOG: "0" },
      fs: fsSync,
      process: fakeProcess,
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    });

    it("releases the lock directory when the wrapper receives SIGINT", async ({ tmp }) => {
      const fakeProcess = createFakeProcess();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fsSync.existsSync(lockDir)).toBe(true);

      fakeProcess.emit("SIGINT");
      expect(fsSync.existsSync(lockDir)).toBe(false);

      // Normal release after signal must be a no-op.
      expect(release()).toBeUndefined();
      expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
      expect(fakeProcess.listenerCount("exit")).toBe(0);
    });

    it("releases the lock directory when the wrapper receives SIGTERM", async ({ tmp }) => {
      const fakeProcess = createFakeProcess();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fsSync.existsSync(lockDir)).toBe(true);

      fakeProcess.emit("SIGTERM");
      expect(fsSync.existsSync(lockDir)).toBe(false);
      expect(release()).toBeUndefined();
    });

    it("releases the lock directory on process exit", async ({ tmp }) => {
      const fakeProcess = createFakeProcess();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fsSync.existsSync(lockDir)).toBe(true);

      fakeProcess.emit("exit");
      expect(fsSync.existsSync(lockDir)).toBe(false);
      expect(release()).toBeUndefined();
    });

    it("detaches signal listeners after a normal release", async ({ tmp }) => {
      const fakeProcess = createFakeProcess();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fakeProcess.listenerCount("SIGINT")).toBe(1);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(1);
      expect(fakeProcess.listenerCount("exit")).toBe(1);

      release();
      expect(fsSync.existsSync(lockDir)).toBe(false);
      expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
      expect(fakeProcess.listenerCount("exit")).toBe(0);
    });

    it("removes a lock left by a dead wrapper process without waiting for age-out", async ({
      tmp,
    }) => {
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: 987654, args: ["gateway"] }),
        "utf-8",
      );

      const fakeProcess = Object.assign(createFakeProcess(), {
        kill: vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
          if (pid === 987654 && signal === 0) {
            const err = new Error("missing process") as Error & { code: string };
            err.code = "ESRCH";
            throw err;
          }
          return true;
        }),
      }) as unknown as NodeJS.Process;

      const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
      expect(fakeProcess["kill"]).toHaveBeenCalledWith(987654, 0);
      expect(JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf-8")).pid).toBe(
        4242,
      );

      release();
      expect(fsSync.existsSync(lockDir)).toBe(false);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
