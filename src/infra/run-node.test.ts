import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  bundledDistPluginFile,
  bundledPluginFile,
  bundledPluginRoot,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mjs";
import {
  acquireRunNodeBuildLock,
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
  runNodeMain,
} from "../../scripts/run-node.mjs";
import { withTempDir } from "../test-helpers/temp-dir.js";

const ROOT_SRC = "src/index.ts";
const ROOT_TSCONFIG = "tsconfig.json";
const ROOT_PACKAGE = "package.json";
const ROOT_TSDOWN = "tsdown.config.ts";
const GENERATED_PLUGIN_ASSET_BUNDLE = "extensions/demo/src/host/assets/view.bundle.js";
const GENERATED_PLUGIN_ASSET_BUNDLE_HASH = "extensions/demo/src/host/assets/.bundle.hash";
const DIST_ENTRY = "dist/entry.js";
const BUILD_STAMP = `dist/${BUILD_STAMP_FILE}`;
const RUNTIME_POSTBUILD_STAMP = `dist/${RUNTIME_POSTBUILD_STAMP_FILE}`;
const DIST_PLUGIN_SDK_INDEX = "dist/plugin-sdk/index.js";
const DIST_PLUGIN_SDK_ROOT_ALIAS = "dist/plugin-sdk/root-alias.cjs";
const DIST_CHANNEL_CATALOG = "dist/channel-catalog.json";
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
const DIST_OPENCLAW_ALIAS_PLUGIN_SDK_INDEX =
  "dist/extensions/node_modules/openclaw/plugin-sdk/index.js";
const DIFFS_PACKAGE = "extensions/diffs/package.json";
const DIFFS_VIEWER_RUNTIME_SOURCE = "extensions/diffs/assets/viewer-runtime.js";
const DIST_DIFFS_VIEWER_RUNTIME = "dist/extensions/diffs/assets/viewer-runtime.js";
const DIST_RUNTIME_DIFFS_VIEWER_RUNTIME = "dist-runtime/extensions/diffs/assets/viewer-runtime.js";
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

async function writeRuntimePostBuildScaffold(tmp: string): Promise<void> {
  const pluginSdkAliasPath = path.join(tmp, "src", "plugin-sdk", "root-alias.cjs");
  await fs.mkdir(path.dirname(pluginSdkAliasPath), { recursive: true });
  await fs.mkdir(path.join(tmp, "extensions"), { recursive: true });
  await fs.writeFile(pluginSdkAliasPath, "module.exports = {};\n", "utf-8");
  await fs.utimes(pluginSdkAliasPath, BUILD_TIME, BUILD_TIME);
  await writeProjectFiles(tmp, {
    [DIST_PLUGIN_SDK_ROOT_ALIAS]: "module.exports = {};\n",
    [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
    [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
    [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]: "export function hasMemoryRuntime() { return false; }\n",
    [DIST_OPENCLAW_ALIAS_PACKAGE]:
      '{"name":"openclaw","type":"module","exports":{"./plugin-sdk":"./plugin-sdk/index.js"}}\n',
  });
  await touchProjectFiles(
    tmp,
    [
      DIST_PLUGIN_SDK_ROOT_ALIAS,
      DIST_CHANNEL_CATALOG,
      DIST_LEGACY_CLI_EXIT_COMPAT,
      DIST_LEGACY_CLI_EXIT_COMPAT_ALT,
      DIST_OPENCLAW_ALIAS_PACKAGE,
    ],
    BUILD_TIME,
  );
}

function expectedBuildSpawn() {
  return [process.execPath, "scripts/tsdown-build.mjs", "--no-clean"];
}

function expectedBundledPluginAssetBuildSpawn() {
  return [process.execPath, "scripts/bundled-plugin-assets.mjs", "--phase", "build"];
}

function statusCommandSpawn() {
  return [process.execPath, "openclaw.mjs", "status"];
}

function gatewayCallStatusCommandSpawn() {
  return [process.execPath, "openclaw.mjs", "gateway", "call", "status", "--json"];
}

function resolvePath(tmp: string, relativePath: string) {
  return path.join(tmp, relativePath);
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
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = resolvePath(tmp, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents, "utf-8");
  }
}

async function touchProjectFiles(tmp: string, relativePaths: string[], time: Date) {
  for (const relativePath of relativePaths) {
    const absolutePath = resolvePath(tmp, relativePath);
    await fs.utimes(absolutePath, time, time);
  }
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

function createBuildRequirementDeps(
  tmp: string,
  options: {
    gitHead?: string;
    gitStatus?: string;
    env?: Record<string, string>;
  } = {},
) {
  const { spawnSync } = createSpawnRecorder({
    gitHead: options.gitHead,
    gitStatus: options.gitStatus,
  });
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

async function runStatusCommand(params: {
  tmp: string;
  spawn: (cmd: string, args: string[]) => ReturnType<typeof createExitedProcess>;
  spawnSync?: (cmd: string, args: string[]) => { status: number; stdout: string };
  env?: Record<string, string>;
  runRuntimePostBuild?: (params?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  }) => void | Promise<void>;
}) {
  return await runNodeMain({
    cwd: params.tmp,
    args: ["status"],
    env: {
      ...process.env,
      OPENCLAW_RUNNER_LOG: "0",
      ...params.env,
    },
    spawn: params.spawn,
    ...(params.spawnSync ? { spawnSync: params.spawnSync } : {}),
    ...(params.runRuntimePostBuild ? { runRuntimePostBuild: params.runRuntimePostBuild } : {}),
    execPath: process.execPath,
    platform: process.platform,
  });
}

async function runGatewayCallStatusCommand(params: {
  tmp: string;
  spawn: (cmd: string, args: string[]) => ReturnType<typeof createExitedProcess>;
  spawnSync?: (cmd: string, args: string[]) => { status: number; stdout: string };
  env?: Record<string, string>;
  runRuntimePostBuild?: (params?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  }) => void | Promise<void>;
}) {
  return await runNodeMain({
    cwd: params.tmp,
    args: ["gateway", "call", "status", "--json"],
    env: {
      ...process.env,
      OPENCLAW_RUNNER_LOG: "0",
      ...params.env,
    },
    spawn: params.spawn,
    ...(params.spawnSync ? { spawnSync: params.spawnSync } : {}),
    ...(params.runRuntimePostBuild ? { runRuntimePostBuild: params.runRuntimePostBuild } : {}),
    execPath: process.execPath,
    platform: process.platform,
  });
}

async function runQaCommand(params: {
  tmp: string;
  spawn: (cmd: string, args: string[]) => ReturnType<typeof createExitedProcess>;
  spawnSync?: (cmd: string, args: string[]) => { status: number; stdout: string };
  env?: Record<string, string>;
  runRuntimePostBuild?: (params?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  }) => void | Promise<void>;
}) {
  return await runNodeMain({
    cwd: params.tmp,
    args: ["qa", "suite", "--transport", "qa-channel", "--provider-mode", "mock-openai"],
    env: {
      ...process.env,
      OPENCLAW_RUNNER_LOG: "0",
      ...params.env,
    },
    spawn: params.spawn,
    ...(params.spawnSync ? { spawnSync: params.spawnSync } : {}),
    ...(params.runRuntimePostBuild ? { runRuntimePostBuild: params.runRuntimePostBuild } : {}),
    execPath: process.execPath,
    platform: process.platform,
  });
}

async function expectManifestId(tmp: string, relativePath: string, id: string) {
  const manifest = JSON.parse(await fs.readFile(resolvePath(tmp, relativePath), "utf-8")) as {
    id?: unknown;
  };
  expect(manifest.id).toBe(id);
}

describe("run-node script", () => {
  it.runIf(process.platform !== "win32")(
    "preserves control-ui assets by building with tsdown --no-clean",
    async () => {
      await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        const argsPath = resolvePath(tmp, ".build-args.txt");
        const indexPath = resolvePath(tmp, "dist/control-ui/index.html");

        await writeRuntimePostBuildScaffold(tmp);
        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, "<html>sentinel</html>\n", "utf-8");

        const nodeCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          if (cmd === process.execPath && args[0] === "scripts/tsdown-build.mjs") {
            fsSync.writeFileSync(argsPath, args.join(" "), "utf-8");
            if (!args.includes("--no-clean")) {
              fsSync.rmSync(resolvePath(tmp, "dist/control-ui"), { recursive: true, force: true });
            }
          }
          if (cmd === process.execPath) {
            nodeCalls.push([cmd, ...args]);
          }
          return createExitedProcess(0);
        };

        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["--version"],
          env: {
            ...process.env,
            OPENCLAW_FORCE_BUILD: "1",
            OPENCLAW_RUNNER_LOG: "0",
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        await expect(fs.readFile(argsPath, "utf-8")).resolves.toContain(
          "scripts/tsdown-build.mjs --no-clean",
        );
        await expect(fs.readFile(indexPath, "utf-8")).resolves.toContain("sentinel");
        expect(nodeCalls).toEqual([
          [process.execPath, "scripts/bundled-plugin-assets.mjs", "--phase", "build"],
          [process.execPath, "scripts/tsdown-build.mjs", "--no-clean"],
          [process.execPath, "openclaw.mjs", "--version"],
        ]);
      });
    },
  );

  it("copies bundled plugin metadata after rebuilding from a clean dist", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);
      await writeProjectFiles(tmp, {
        [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
        [EXTENSION_PACKAGE]:
          JSON.stringify(
            {
              name: "demo",
              openclaw: {
                extensions: ["./src/index.ts", "./nested/entry.mts"],
              },
            },
            null,
            2,
          ) + "\n",
      });

      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };

      const exitCode = await runStatusCommand({
        tmp,
        spawn,
        env: { OPENCLAW_FORCE_BUILD: "1" },
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        expectedBundledPluginAssetBuildSpawn(),
        expectedBuildSpawn(),
        statusCommandSpawn(),
      ]);

      await expect(
        fs.readFile(resolvePath(tmp, "dist/plugin-sdk/root-alias.cjs"), "utf-8"),
      ).resolves.toContain("module.exports = {};");
      await expectManifestId(tmp, DIST_EXTENSION_MANIFEST, "demo");
      await expect(
        fs.readFile(resolvePath(tmp, DIST_EXTENSION_PACKAGE), "utf-8"),
      ).resolves.toContain(
        '"extensions": [\n      "./src/index.js",\n      "./nested/entry.js"\n    ]',
      );
    });
  });

  it("tees launcher output into the requested generic output log", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
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

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["status"],
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "1",
          OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath,
        },
        spawn,
        stderr: mutedStream,
        stdout: mutedStream,
        execPath: process.execPath,
        platform: process.platform,
      } as Parameters<typeof runNodeMain>[0] & { stdout: NodeJS.WriteStream });

      expect(exitCode).toBe(0);
      await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain("child stdout\n");
      await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain("child stderr\n");
      await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain("[openclaw]");
      expect(spawnCalls.at(-1)?.args).toEqual(["openclaw.mjs", "status"]);
      expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_OUTPUT_LOG).toBe(outputPath);
      expect(spawnCalls.at(-1)?.stdio).toEqual(["inherit", "pipe", "pipe"]);
    });
  });

  it("routes sync I/O trace stderr blocks to the output log without flooding stderr", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
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

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["status"],
        env: {
          ...process.env,
          OPENCLAW_RUNNER_LOG: "0",
          OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR: "1",
          OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath,
        },
        spawn,
        stderr,
        stdout,
        execPath: process.execPath,
        platform: process.platform,
      } as Parameters<typeof runNodeMain>[0] & { stdout: NodeJS.WriteStream });

      expect(exitCode).toBe(0);
      const terminalStderr = stderrChunks.join("");
      expect(terminalStderr).toContain("normal before\n");
      expect(terminalStderr).toContain("normal after\n");
      expect(terminalStderr).not.toContain("Detected use of sync API");
      expect(terminalStderr).not.toContain("statSync");
      await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain(childStderr);
    });
  });

  it("adds Node CPU profiling flags to the launched OpenClaw child when requested", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [DIST_PLUGIN_SDK_ROOT_ALIAS]: "module.exports = {};\n",
          [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
          [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
          [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]:
            "export function hasMemoryRuntime() { return false; }\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [
          DIST_ENTRY,
          DIST_PLUGIN_SDK_ROOT_ALIAS,
          DIST_CHANNEL_CATALOG,
          DIST_LEGACY_CLI_EXIT_COMPAT,
          DIST_LEGACY_CLI_EXIT_COMPAT_ALT,
          BUILD_STAMP,
        ],
      });
      const profileDir = path.join(tmp, ".artifacts", "profiles");
      const spawnCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const spawn = (_cmd: string, args: string[], options?: unknown) => {
        const opts = options as { env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({ args, env: { ...opts?.env } });
        return createExitedProcess(0);
      };
      const { spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["status"],
        env: {
          ...process.env,
          OPENCLAW_RUNNER_LOG: "0",
          OPENCLAW_RUN_NODE_CPU_PROF_DIR: ".artifacts/profiles",
        },
        spawn,
        spawnSync,
        execPath: process.execPath,
        platform: process.platform,
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
  });

  it("adds Node sync I/O tracing flag to the launched OpenClaw child when requested", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });
      const spawnCalls: string[][] = [];
      const spawn = (_cmd: string, args: string[]) => {
        spawnCalls.push(args);
        return createExitedProcess(0);
      };
      const { spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["gateway", "--force"],
        env: {
          ...process.env,
          OPENCLAW_RUNNER_LOG: "0",
          OPENCLAW_TRACE_SYNC_IO: "1",
        },
        spawn,
        spawnSync,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls.at(-1)).toEqual(["--trace-sync-io", "openclaw.mjs", "gateway", "--force"]);
    });
  });

  it("surfaces generic output log stream errors", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
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

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["status"],
        env: {
          ...process.env,
          OPENCLAW_RUNNER_LOG: "0",
          OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath,
        },
        spawn,
        stderr: mutedStream,
        stdout: mutedStream,
        execPath: process.execPath,
        platform: process.platform,
      } as Parameters<typeof runNodeMain>[0] & { stdout: NodeJS.WriteStream });

      expect(exitCode).toBe(1);
      expect(stderrChunks.join("")).toContain("Failed to write output log");
    });
  });

  it("does not mutate Matrix QA args when no generic output log is requested", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
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

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["qa", "matrix"],
        env: {
          ...process.env,
          OPENCLAW_RUNNER_LOG: "0",
        },
        spawn,
        stderr: mutedStream,
        stdout: mutedStream,
        execPath: process.execPath,
        platform: process.platform,
      } as Parameters<typeof runNodeMain>[0] & { stdout: NodeJS.WriteStream });

      expect(exitCode).toBe(0);
      const childArgs = spawnCalls.at(-1)?.args ?? [];
      expect(childArgs).toEqual(["openclaw.mjs", "qa", "matrix"]);
      expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_OUTPUT_LOG).toBeUndefined();
    });
  });

  it("skips rebuilding when dist is current and the source tree is clean", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([statusCommandSpawn()]);
    });
  });

  it("skips rebuilding for private QA commands when the private QA facades are present", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
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
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });
      const exitCode = await runQaCommand({ tmp, spawn, spawnSync });

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
  });

  it("rebuilds private QA commands when the private QA runtime facade is missing", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, QA_LAB_PLUGIN_SDK_ENTRY],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });
      const exitCode = await runQaCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        expectedBundledPluginAssetBuildSpawn(),
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
  });

  it("passes the synthesized private QA env into runtime postbuild staging", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, QA_LAB_PLUGIN_SDK_ENTRY],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const runRuntimePostBuild = vi.fn();
      const { spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });
      const exitCode = await runQaCommand({ tmp, spawn, spawnSync, runRuntimePostBuild });

      expect(exitCode).toBe(0);
      expect(runRuntimePostBuild).toHaveBeenCalledTimes(1);
      const postBuildParams = runRuntimePostBuild.mock.calls[0]?.[0] as
        | { cwd?: string; env?: Record<string, string | undefined> }
        | undefined;
      expect(postBuildParams?.cwd).toBe(tmp);
      expect(postBuildParams?.env?.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
      expect(postBuildParams?.env?.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    });
  });

  it("derives private QA facade checks from distRoot for direct freshness checks", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, QA_LAB_PLUGIN_SDK_ENTRY],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const requirement = resolveBuildRequirement(
        createBuildRequirementDeps(tmp, {
          env: { OPENCLAW_BUILD_PRIVATE_QA: "1" },
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldBuild: true,
        reason: "missing_private_qa_dist",
      });
    });
  });

  it("skips runtime postbuild restaging in watch mode when dist is already current", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
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
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
    });
  });

  it("reruns runtime postbuild in watch mode when required outputs are missing with no runtime stamp", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [DIST_PLUGIN_SDK_ROOT_ALIAS]: "module.exports = {};\n",
          [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
          [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]:
            "export function hasMemoryRuntime() { return false; }\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [
          DIST_ENTRY,
          DIST_PLUGIN_SDK_ROOT_ALIAS,
          DIST_LEGACY_CLI_EXIT_COMPAT,
          DIST_LEGACY_CLI_EXIT_COMPAT_ALT,
          BUILD_STAMP,
        ],
      });
      await fs.rm(resolvePath(tmp, DIST_OPENCLAW_ALIAS_PACKAGE));

      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
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
  });

  it("reruns runtime postbuild for dirty extension package metadata in watch mode", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.ts"]}}\n',
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_PACKAGE,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          DIST_ENTRY,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });

      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
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
  });

  it("runs QA parity report from source without rebuilding private QA dist", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          "extensions/qa-lab/src/cli.runtime.ts": "export {};\n",
        },
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: [
          "qa",
          "parity-report",
          "--candidate-summary",
          ".artifacts/qa-e2e/gpt54/qa-suite-summary.json",
          "--baseline-summary",
          ".artifacts/qa-e2e/opus46/qa-suite-summary.json",
        ],
        env: {
          ...process.env,
          OPENCLAW_RUNNER_LOG: "0",
        },
        spawn,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        [
          process.execPath,
          "--import",
          "tsx",
          path.join(tmp, "scripts", "qa-parity-report.ts"),
          "--candidate-summary",
          ".artifacts/qa-e2e/gpt54/qa-suite-summary.json",
          "--baseline-summary",
          ".artifacts/qa-e2e/opus46/qa-suite-summary.json",
        ],
      ]);
    });
  });

  it("runs QA coverage report from source without rebuilding private QA dist", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          "extensions/qa-lab/src/cli.runtime.ts": "export {};\n",
        },
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["qa", "coverage", "--json"],
        env: {
          ...process.env,
          OPENCLAW_RUNNER_LOG: "0",
        },
        spawn,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        [
          process.execPath,
          "--import",
          "tsx",
          path.join(tmp, "scripts", "qa-coverage-report.ts"),
          "--json",
        ],
      ]);
    });
  });

  it("skips runtime postbuild restaging when the runtime stamp is current", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP, RUNTIME_POSTBUILD_STAMP],
      });

      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });
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
  });

  it("restages runtime artifacts when runtime metadata is dirty", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_INDEX]: "export default {};\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [DIST_EXTENSION_INDEX]: "export default {};\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_INDEX,
          EXTENSION_MANIFEST,
          DIST_EXTENSION_INDEX,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          DIST_ENTRY,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });

      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
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
  });

  it("serializes runtime postbuild restaging across concurrent clean launchers", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

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
      const { spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });

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
  });

  it("returns the build exit code when the compiler step fails", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      const spawn = (cmd: string, args: string[] = []) => {
        if (cmd === process.execPath && args[0] === "scripts/tsdown-build.mjs") {
          return createExitedProcess(23);
        }
        return createExitedProcess(0);
      };

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["status"],
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
        },
        spawn,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(23);
    });
  });

  it("returns failure and releases the build lock when the compiler spawn errors", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      const spawn = (cmd: string, args: string[] = []) => {
        if (cmd === process.execPath && args[0] === "scripts/tsdown-build.mjs") {
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
      };

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["status"],
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
        },
        spawn,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(1);
      expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
    });
  });

  it("forwards wrapper SIGTERM to the active openclaw child and returns 143", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const fakeProcess = createFakeProcess();
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

      const exitCodePromise = runNodeMain({
        cwd: tmp,
        args: ["status"],
        env: {
          ...process.env,
          OPENCLAW_RUNNER_LOG: "0",
        },
        process: fakeProcess,
        spawn,
        execPath: process.execPath,
      });

      await vi.waitFor(() => {
        expect(spawn).toHaveBeenCalled();
      });
      fakeProcess.emit("SIGTERM");
      const exitCode = await exitCodePromise;

      expect(exitCode).toBe(143);
      expect(spawn).toHaveBeenCalledTimes(1);
      const spawnCall = spawn.mock.calls[0] as [string, string[], { stdio?: unknown }] | undefined;
      expect(spawnCall?.[0]).toBe(process.execPath);
      expect(spawnCall?.[1]).toEqual(["openclaw.mjs", "status"]);
      expect(spawnCall?.[2].stdio).toBe("inherit");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
    });
  });

  it("rebuilds when extension sources are newer than the build stamp", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [EXTENSION_SRC]: "export const extensionValue = 1;\n",
        },
        buildPaths: [ROOT_TSCONFIG, ROOT_PACKAGE, DIST_ENTRY, BUILD_STAMP],
        newPaths: [EXTENSION_SRC],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder();
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        expectedBundledPluginAssetBuildSpawn(),
        expectedBuildSpawn(),
        statusCommandSpawn(),
      ]);
    });
  });

  it("rebuilds when git HEAD changes even if source mtimes do not exceed the old build stamp", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "def456\n",
        gitStatus: "",
      });
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        expectedBundledPluginAssetBuildSpawn(),
        expectedBuildSpawn(),
        statusCommandSpawn(),
      ]);
    });
  });

  it("skips rebuilding when extension package metadata is newer than the build stamp", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [EXTENSION_INDEX]: "export default {};\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [EXTENSION_PACKAGE]: '{"name":"demo","openclaw":{"extensions":["./index.ts"]}}\n',
          [ROOT_TSDOWN]: "export default {};\n",
          [DIST_EXTENSION_INDEX]: "export default {};\n",
          [DIST_EXTENSION_PACKAGE]: '{"name":"demo","openclaw":{"extensions":["./stale.js"]}}\n',
        },
        oldPaths: [EXTENSION_INDEX, EXTENSION_MANIFEST, ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
        buildPaths: [DIST_ENTRY, BUILD_STAMP, DIST_EXTENSION_INDEX, DIST_EXTENSION_PACKAGE],
        newPaths: [EXTENSION_PACKAGE],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder();
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([statusCommandSpawn()]);
      await expect(
        fs.readFile(resolvePath(tmp, DIST_EXTENSION_PACKAGE), "utf-8"),
      ).resolves.toContain('"./index.js"');
    });
  });

  it("skips rebuilding for dirty non-source files under extensions", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_README]: "# demo\n",
          [ROOT_TSDOWN]: "export default {};\n",
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_README,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          ROOT_TSDOWN,
          DIST_ENTRY,
          BUILD_STAMP,
        ],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: ` M ${EXTENSION_README}\n`,
      });
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([statusCommandSpawn()]);
    });
  });

  it("skips rebuilding for dirty extension manifests that only affect runtime reload", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_INDEX]: "export default {};\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [ROOT_TSDOWN]: "export default {};\n",
          [DIST_EXTENSION_INDEX]: "export default {};\n",
          [DIST_EXTENSION_MANIFEST]: '{"id":"stale","configSchema":{"type":"object"}}\n',
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_INDEX,
          EXTENSION_MANIFEST,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          ROOT_TSDOWN,
          DIST_ENTRY,
          BUILD_STAMP,
          DIST_EXTENSION_INDEX,
          DIST_EXTENSION_MANIFEST,
        ],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: ` M ${EXTENSION_MANIFEST}\n`,
      });
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([statusCommandSpawn()]);
      await expectManifestId(tmp, DIST_EXTENSION_MANIFEST, "demo");
    });
  });

  it("reports dirty watched source trees as an explicit build reason", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        buildPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, DIST_ENTRY, BUILD_STAMP],
      });

      const requirement = resolveBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: ` M ${ROOT_SRC}\n`,
        }),
      );

      expect(requirement).toEqual({
        shouldBuild: true,
        reason: "dirty_watched_tree",
      });
    });
  });

  it("does not rebuild for gateway client calls against an existing dirty dist", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          DIST_ENTRY,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });

      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: ` M ${ROOT_SRC}\n`,
      });
      const exitCode = await runGatewayCallStatusCommand({
        tmp,
        spawn,
        spawnSync,
        runRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([gatewayCallStatusCommandSpawn()]);
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
    });
  });

  it("reports a clean tree explicitly when dist is current", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const requirement = resolveBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldBuild: false,
        reason: "clean",
      });
    });
  });

  it("reports clean in sparse worktrees without bundled plugin sources", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });
      await fs.rm(resolvePath(tmp, "extensions"), { recursive: true, force: true });

      const requirement = resolveBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldBuild: false,
        reason: "clean",
      });
    });
  });

  it("rebuilds when dirty bundled package entries point at missing dist outputs", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_SRC]: "export default {};\n",
          [EXTENSION_EXTRA_SRC]: "export const extra = true;\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts","./src/extra.ts"]}}\n',
          [DIST_EXTENSION_SRC]: "export default {};\n",
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_SRC,
          EXTENSION_EXTRA_SRC,
          EXTENSION_MANIFEST,
          EXTENSION_PACKAGE,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          DIST_ENTRY,
          DIST_EXTENSION_SRC,
          BUILD_STAMP,
        ],
      });

      const requirement = resolveBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: ` M ${EXTENSION_PACKAGE}\n`,
        }),
      );

      expect(requirement).toEqual({
        shouldBuild: true,
        reason: "dirty_watched_tree",
      });
    });
  });

  it("rebuilds when clean bundled plugin dist outputs are partially missing", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_SRC]: "export default {};\n",
          [EXTENSION_EXTRA_SRC]: "export const extra = true;\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts","./src/extra.ts"]}}\n',
          [DIST_EXTENSION_SRC]: "export default {};\n",
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_SRC,
          EXTENSION_EXTRA_SRC,
          EXTENSION_MANIFEST,
          EXTENSION_PACKAGE,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          DIST_ENTRY,
          DIST_EXTENSION_SRC,
          BUILD_STAMP,
        ],
      });

      const requirement = resolveBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldBuild: true,
        reason: "missing_bundled_plugin_dist_entry",
      });
    });
  });

  it("rebuilds when a clean stamped bundled plugin dist directory is missing", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_SRC]: "export default {};\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./src/index.ts"]}}\n',
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_SRC,
          EXTENSION_MANIFEST,
          EXTENSION_PACKAGE,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          DIST_ENTRY,
          BUILD_STAMP,
        ],
      });

      const requirement = resolveBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldBuild: true,
        reason: "missing_bundled_plugin_dist_entry",
      });
    });
  });

  it("reports clean runtime postbuild artifacts when the runtime stamp matches HEAD", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP, RUNTIME_POSTBUILD_STAMP],
      });

      const requirement = resolveRuntimePostBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldSync: false,
        reason: "clean",
      });
    });
  });

  it("reports missing runtime postbuild outputs even when stamps match HEAD", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
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
        buildPaths: [
          ROOT_SRC,
          EXTENSION_SRC,
          EXTENSION_MANIFEST,
          EXTENSION_PACKAGE,
          DIST_ENTRY,
          DIST_EXTENSION_SRC,
          DIST_EXTENSION_MANIFEST,
          DIST_EXTENSION_PACKAGE,
          DIST_EXTENSION_RUNTIME_SRC,
          DIST_RUNTIME_EXTENSION_MANIFEST,
          DIST_RUNTIME_EXTENSION_PACKAGE,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });
      await fs.rm(resolvePath(tmp, DIST_EXTENSION_PACKAGE));

      const requirement = resolveRuntimePostBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
    });
  });

  it("reports missing runtime overlay outputs from restored dist without plugin sources", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [DIST_EXTENSION_INDEX]: "export default {};\n",
          [DIST_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [DIST_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
          [DIST_RUNTIME_EXTENSION_INDEX]: "export default {};\n",
          [DIST_RUNTIME_EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [DIST_RUNTIME_EXTENSION_PACKAGE]: '{"openclaw":{"extensions":["./index.js"]}}\n',
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          DIST_ENTRY,
          DIST_EXTENSION_INDEX,
          DIST_EXTENSION_MANIFEST,
          DIST_EXTENSION_PACKAGE,
          DIST_RUNTIME_EXTENSION_INDEX,
          DIST_RUNTIME_EXTENSION_MANIFEST,
          DIST_RUNTIME_EXTENSION_PACKAGE,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });
      await fs.rm(resolvePath(tmp, "extensions"), { recursive: true, force: true });
      await fs.rm(resolvePath(tmp, DIST_RUNTIME_EXTENSION_INDEX));

      const requirement = resolveRuntimePostBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
    });
  });

  it("does not require OpenClaw SDK alias outputs when dist extensions are absent", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [DIST_PLUGIN_SDK_INDEX]: "export * from './core.js';\n",
          [DIST_PLUGIN_SDK_ROOT_ALIAS]: "module.exports = {};\n",
          [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
          [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
          [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]:
            "export function hasMemoryRuntime() { return false; }\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          DIST_ENTRY,
          DIST_PLUGIN_SDK_INDEX,
          DIST_PLUGIN_SDK_ROOT_ALIAS,
          DIST_CHANNEL_CATALOG,
          DIST_LEGACY_CLI_EXIT_COMPAT,
          DIST_LEGACY_CLI_EXIT_COMPAT_ALT,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });
      await fs.rm(path.join(tmp, "dist", "extensions"), { recursive: true, force: true });

      const requirement = resolveRuntimePostBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldSync: false,
        reason: "clean",
      });
    });
  });

  it("reports missing OpenClaw SDK alias outputs when runtime stamps match HEAD", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [DIST_PLUGIN_SDK_INDEX]: "export * from './core.js';\n",
          [DIST_OPENCLAW_ALIAS_PACKAGE]:
            '{"name":"openclaw","type":"module","exports":{"./plugin-sdk":"./plugin-sdk/index.js"}}\n',
          [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_INDEX]:
            "export * from '../../../../plugin-sdk/index.js';\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          DIST_ENTRY,
          DIST_PLUGIN_SDK_INDEX,
          DIST_OPENCLAW_ALIAS_PACKAGE,
          DIST_OPENCLAW_ALIAS_PLUGIN_SDK_INDEX,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });
      await fs.rm(resolvePath(tmp, DIST_OPENCLAW_ALIAS_PLUGIN_SDK_INDEX));

      const requirement = resolveRuntimePostBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
    });
  });

  it("reports missing static runtime postbuild asset outputs when runtime stamps match HEAD", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [DIFFS_PACKAGE]:
            '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
          [DIFFS_VIEWER_RUNTIME_SOURCE]: "export {};\n",
          [DIST_DIFFS_VIEWER_RUNTIME]: "export {};\n",
          [DIST_RUNTIME_DIFFS_VIEWER_RUNTIME]: "export {};\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          DIFFS_PACKAGE,
          DIFFS_VIEWER_RUNTIME_SOURCE,
          DIST_DIFFS_VIEWER_RUNTIME,
          DIST_RUNTIME_DIFFS_VIEWER_RUNTIME,
          DIST_ENTRY,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });
      await fs.rm(resolvePath(tmp, DIST_DIFFS_VIEWER_RUNTIME));

      const requirement = resolveRuntimePostBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
    });
  });

  it("does not require static asset outputs when the declared source is absent", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [DIFFS_PACKAGE]:
            '{"openclaw":{"build":{"staticAssets":[{"source":"./assets/viewer-runtime.js","output":"assets/viewer-runtime.js"}]}}}\n',
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [ROOT_SRC, DIFFS_PACKAGE, DIST_ENTRY, BUILD_STAMP, RUNTIME_POSTBUILD_STAMP],
      });

      const requirement = resolveRuntimePostBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldSync: false,
        reason: "clean",
      });
    });
  });

  it("reports missing core runtime postbuild outputs when runtime stamps match HEAD", async () => {
    for (const missingPath of [
      DIST_PLUGIN_SDK_ROOT_ALIAS,
      DIST_CHANNEL_CATALOG,
      DIST_LEGACY_CLI_EXIT_COMPAT,
      DIST_STABLE_ROOT_RUNTIME_ALIAS,
      DIST_LEGACY_ROOT_RUNTIME_COMPAT,
    ]) {
      await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        await setupTrackedProject(tmp, {
          files: {
            [ROOT_SRC]: "export const value = 1;\n",
            [DIST_STABLE_ROOT_RUNTIME_SOURCE]: "export const value = 1;\n",
            [DIST_STABLE_ROOT_RUNTIME_ALIAS]:
              "export * from './model-catalog.runtime-AbCd1234.js';\n",
            [DIST_LEGACY_ROOT_RUNTIME_TARGET]: "export const aborted = true;\n",
            [DIST_LEGACY_ROOT_RUNTIME_COMPAT]: "export * from './abort.runtime.js';\n",
            [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
          },
          buildPaths: [
            ROOT_SRC,
            DIST_ENTRY,
            DIST_STABLE_ROOT_RUNTIME_SOURCE,
            DIST_STABLE_ROOT_RUNTIME_ALIAS,
            DIST_LEGACY_ROOT_RUNTIME_TARGET,
            DIST_LEGACY_ROOT_RUNTIME_COMPAT,
            BUILD_STAMP,
            RUNTIME_POSTBUILD_STAMP,
          ],
        });
        await fs.rm(resolvePath(tmp, missingPath));

        const requirement = resolveRuntimePostBuildRequirement(
          createBuildRequirementDeps(tmp, {
            gitHead: "abc123\n",
            gitStatus: "",
          }),
        );

        expect(requirement).toEqual({
          shouldSync: true,
          reason: "missing_runtime_postbuild_output",
        });
      });
    }
  });

  it("does not require ambiguous stable runtime aliases that postbuild cannot create", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [DIST_STABLE_ROOT_RUNTIME_SOURCE]: "export const value = 1;\n",
          [DIST_STABLE_ROOT_RUNTIME_SOURCE_ALT]: "export const value = 2;\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          DIST_ENTRY,
          DIST_STABLE_ROOT_RUNTIME_SOURCE,
          DIST_STABLE_ROOT_RUNTIME_SOURCE_ALT,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });

      const requirement = resolveRuntimePostBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldSync: false,
        reason: "clean",
      });
    });
  });

  it("reports missing runtime skill outputs even when stamps match HEAD", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
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
        buildPaths: [
          ROOT_SRC,
          EXTENSION_INDEX,
          EXTENSION_MANIFEST,
          EXTENSION_SKILL,
          DIST_ENTRY,
          DIST_EXTENSION_INDEX,
          DIST_EXTENSION_MANIFEST,
          DIST_EXTENSION_SKILL,
          DIST_RUNTIME_EXTENSION_INDEX,
          DIST_RUNTIME_EXTENSION_MANIFEST,
          DIST_RUNTIME_EXTENSION_SKILL,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });
      await fs.rm(resolvePath(tmp, DIST_RUNTIME_EXTENSION_SKILL));

      const requirement = resolveRuntimePostBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: "",
        }),
      );

      expect(requirement).toEqual({
        shouldSync: true,
        reason: "missing_runtime_postbuild_output",
      });
    });
  });

  it("reports dirty runtime postbuild inputs separately from rebuild inputs", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_INDEX]: "export default {};\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
          [DIST_EXTENSION_INDEX]: "export default {};\n",
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_INDEX,
          EXTENSION_MANIFEST,
          DIST_EXTENSION_INDEX,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          DIST_ENTRY,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });

      const deps = createBuildRequirementDeps(tmp, {
        gitHead: "abc123\n",
        gitStatus: ` M ${EXTENSION_MANIFEST}\n`,
      });

      expect(resolveBuildRequirement(deps)).toEqual({
        shouldBuild: false,
        reason: "clean",
      });
      expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
        shouldSync: true,
        reason: "dirty_runtime_postbuild_inputs",
      });
    });
  });

  it("ignores dirty generated plugin bundle artifacts when dist is current", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
      });

      const requirement = resolveBuildRequirement(
        createBuildRequirementDeps(tmp, {
          gitHead: "abc123\n",
          gitStatus: ` M ${GENERATED_PLUGIN_ASSET_BUNDLE_HASH}\n M ${GENERATED_PLUGIN_ASSET_BUNDLE}\n`,
        }),
      );

      expect(requirement).toEqual({
        shouldBuild: false,
        reason: "clean",
      });
    });
  });

  it("reports bundled skill edits as runtime postbuild inputs", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","skills":["./skills/SKILL.md"]}\n',
          [EXTENSION_SKILL]: "# Demo\n",
          [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_MANIFEST,
          EXTENSION_SKILL,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          DIST_ENTRY,
          BUILD_STAMP,
          RUNTIME_POSTBUILD_STAMP,
        ],
      });

      const deps = createBuildRequirementDeps(tmp, {
        gitHead: "abc123\n",
        gitStatus: ` M ${EXTENSION_SKILL}\n`,
      });

      expect(resolveRuntimePostBuildRequirement(deps)).toEqual({
        shouldSync: true,
        reason: "dirty_runtime_postbuild_inputs",
      });
    });
  });

  it("repairs missing bundled plugin metadata without rerunning tsdown", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_INDEX]: "export default {};\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [ROOT_TSDOWN]: "export default {};\n",
          [DIST_EXTENSION_INDEX]: "export default {};\n",
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_INDEX,
          EXTENSION_MANIFEST,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          ROOT_TSDOWN,
          DIST_ENTRY,
          DIST_EXTENSION_INDEX,
          BUILD_STAMP,
        ],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([statusCommandSpawn()]);
      await expectManifestId(tmp, DIST_EXTENSION_MANIFEST, "demo");
    });
  });

  it("removes stale bundled plugin metadata when the source manifest is gone", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [ROOT_TSDOWN]: "export default {};\n",
          [DIST_EXTENSION_MANIFEST]: '{"id":"stale","configSchema":{"type":"object"}}\n',
          [DIST_EXTENSION_PACKAGE]: '{"name":"stale"}\n',
        },
        buildPaths: [
          ROOT_SRC,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          ROOT_TSDOWN,
          DIST_ENTRY,
          BUILD_STAMP,
          DIST_EXTENSION_MANIFEST,
          DIST_EXTENSION_PACKAGE,
        ],
      });

      await fs.mkdir(resolvePath(tmp, bundledPluginRoot("demo")), { recursive: true });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([statusCommandSpawn()]);
      await expectPathMissing(resolvePath(tmp, DIST_EXTENSION_MANIFEST));
      await expectPathMissing(resolvePath(tmp, DIST_EXTENSION_PACKAGE));
    });
  });

  it("skips rebuilding when only non-source extension files are newer than the build stamp", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_README]: "# demo\n",
          [ROOT_TSDOWN]: "export default {};\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
        newPaths: [EXTENSION_README],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder();
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([statusCommandSpawn()]);
    });
  });

  it("rebuilds when tsdown config is newer than the build stamp", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [ROOT_TSDOWN]: "export default {};\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        buildPaths: [DIST_ENTRY, BUILD_STAMP],
        newPaths: [ROOT_TSDOWN],
      });

      const { spawnCalls, spawn, spawnSync } = createSpawnRecorder({
        gitHead: "abc123\n",
        gitStatus: "",
      });
      const exitCode = await runStatusCommand({ tmp, spawn, spawnSync });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        expectedBundledPluginAssetBuildSpawn(),
        expectedBuildSpawn(),
        statusCommandSpawn(),
      ]);
    });
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

    it("releases the lock directory when the wrapper receives SIGINT", async () => {
      await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
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
    });

    it("releases the lock directory when the wrapper receives SIGTERM", async () => {
      await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        const fakeProcess = createFakeProcess();
        const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

        const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
        expect(fsSync.existsSync(lockDir)).toBe(true);

        fakeProcess.emit("SIGTERM");
        expect(fsSync.existsSync(lockDir)).toBe(false);
        expect(release()).toBeUndefined();
      });
    });

    it("releases the lock directory on process exit", async () => {
      await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        const fakeProcess = createFakeProcess();
        const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

        const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
        expect(fsSync.existsSync(lockDir)).toBe(true);

        fakeProcess.emit("exit");
        expect(fsSync.existsSync(lockDir)).toBe(false);
        expect(release()).toBeUndefined();
      });
    });

    it("detaches signal listeners after a normal release", async () => {
      await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
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
    });

    it("removes a lock left by a dead wrapper process without waiting for age-out", async () => {
      await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
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
        expect(fakeProcess.kill).toHaveBeenCalledWith(987654, 0);
        expect(JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf-8")).pid).toBe(
          4242,
        );

        release();
        expect(fsSync.existsSync(lockDir)).toBe(false);
      });
    });
  });
});
