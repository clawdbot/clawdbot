import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveBuildRequirement, runNodeMain } from "../../scripts/run-node.mjs";
import {
  bundledDistPluginFile,
  bundledPluginFile,
  bundledPluginRoot,
} from "../../test/helpers/bundled-plugin-paths.js";
import { withTempDir } from "../test-helpers/temp-dir.js";

const ROOT_SRC = "src/index.ts";
const ROOT_TSCONFIG = "tsconfig.json";
const ROOT_PACKAGE = "package.json";
const ROOT_TSDOWN = "tsdown.config.ts";
const DIST_ENTRY = "dist/entry.js";
const BUILD_STAMP = "dist/.buildstamp";
const EXTENSION_SRC = bundledPluginFile("demo", "src/index.ts");
const EXTENSION_MANIFEST = bundledPluginFile("demo", "openclaw.plugin.json");
const EXTENSION_PACKAGE = bundledPluginFile("demo", "package.json");
const EXTENSION_README = bundledPluginFile("demo", "README.md");
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
}

function expectedBuildSpawn() {
  return [process.execPath, "scripts/tsdown-build.mjs", "--no-clean"];
}

function statusCommandSpawn() {
  return [process.execPath, "openclaw.mjs", "status"];
}

function resolvePath(tmp: string, relativePath: string) {
  return path.join(tmp, relativePath);
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
  runRuntimePostBuild?: (params?: { cwd?: string }) => void;
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

async function expectManifestId(tmp: string, relativePath: string, id: string) {
  await expect(
    fs.readFile(resolvePath(tmp, relativePath), "utf-8").then((raw) => JSON.parse(raw)),
  ).resolves.toMatchObject({ id });
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
      expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);

      await expect(
        fs.readFile(resolvePath(tmp, "dist/plugin-sdk/root-alias.cjs"), "utf-8"),
      ).resolves.toContain("module.exports = {};");
      await expect(
        fs
          .readFile(resolvePath(tmp, DIST_EXTENSION_MANIFEST), "utf-8")
          .then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({ id: "demo" });
      await expect(
        fs.readFile(resolvePath(tmp, DIST_EXTENSION_PACKAGE), "utf-8"),
      ).resolves.toContain(
        '"extensions": [\n      "./src/index.js",\n      "./nested/entry.js"\n    ]',
      );
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

      fakeProcess.emit("SIGTERM");
      const exitCode = await exitCodePromise;

      expect(exitCode).toBe(143);
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        ["openclaw.mjs", "status"],
        expect.objectContaining({ stdio: "inherit" }),
      );
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
      expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);
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
      expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);
    });
  });

  it("skips rebuilding when extension package metadata is newer than the build stamp", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [EXTENSION_PACKAGE]: '{"name":"demo","openclaw":{"extensions":["./index.ts"]}}\n',
          [ROOT_TSDOWN]: "export default {};\n",
          [DIST_EXTENSION_PACKAGE]: '{"name":"demo","openclaw":{"extensions":["./stale.js"]}}\n',
        },
        oldPaths: [EXTENSION_MANIFEST, ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
        buildPaths: [DIST_ENTRY, BUILD_STAMP, DIST_EXTENSION_PACKAGE],
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
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [ROOT_TSDOWN]: "export default {};\n",
          [DIST_EXTENSION_MANIFEST]: '{"id":"stale","configSchema":{"type":"object"}}\n',
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_MANIFEST,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          ROOT_TSDOWN,
          DIST_ENTRY,
          BUILD_STAMP,
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

  it("repairs missing bundled plugin metadata without rerunning tsdown", async () => {
    await withTempDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupTrackedProject(tmp, {
        files: {
          [ROOT_SRC]: "export const value = 1;\n",
          [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
          [ROOT_TSDOWN]: "export default {};\n",
        },
        buildPaths: [
          ROOT_SRC,
          EXTENSION_MANIFEST,
          ROOT_TSCONFIG,
          ROOT_PACKAGE,
          ROOT_TSDOWN,
          DIST_ENTRY,
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
      await expect(fs.access(resolvePath(tmp, DIST_EXTENSION_MANIFEST))).rejects.toThrow();
      await expect(fs.access(resolvePath(tmp, DIST_EXTENSION_PACKAGE))).rejects.toThrow();
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
      expect(spawnCalls).toEqual([expectedBuildSpawn(), statusCommandSpawn()]);
    });
  });
});
