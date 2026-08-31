// Tsdown Build tests cover tsdown build script behavior.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
} from "../../scripts/lib/tsdown-config-groups.mts";
import {
  cleanTsdownOutputRoots,
  createTsdownOutputScanner,
  describeInsufficientTsdownHeap,
  listTsdownOutputRoots,
  parseTsdownBuildArgs,
  prepareTsdownBuildExecution,
  pruneStaleRootChunkFiles,
  pruneStaleRuntimeSymlinks,
  pruneUntrackedGeneratedSourceDeclarations,
  resolveTsdownBuildInvocation,
  resolveTsdownBuildInvocations,
  resolveTsdownBuildPlan,
  resolveTsdownCleanOutputRoots,
  runTsdownBuildInvocation as runTsdownBuildInvocationImpl,
} from "../../scripts/tsdown-build.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForFile,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { createSourcePluginDependenciesFixture } from "./source-plugin-dependencies-fixture.js";

const fixture = createFixtureLifetime();
const { createTempDir } = fixture;
afterEach(() => fixture.cleanup());
const runTsdownBuildInvocation = (...args: Parameters<typeof runTsdownBuildInvocationImpl>) =>
  fixture.track(runTsdownBuildInvocationImpl(...args));
const TEST_PHYSICAL_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;
// Memory detection is a process-global input. Freeze it for this suite so fake cgroup
// fixtures prove only their declared hierarchy instead of inheriting the runner's RAM.
vi.spyOn(os, "totalmem").mockReturnValue(TEST_PHYSICAL_MEMORY_BYTES);
const readFileSync = fs.readFileSync.bind(fs);
vi.spyOn(fs, "readFileSync").mockImplementation((filePath, options) =>
  filePath === "/proc/meminfo" && options === "utf8"
    ? "MemTotal:       16777216 kB\nMemAvailable:   16777216 kB\n"
    : readFileSync(filePath, options),
);
const NO_MEMORY_LIMIT = {
  availableMemoryBytes: TEST_PHYSICAL_MEMORY_BYTES,
  cgroupMemoryLimitPaths: [],
  constrainedMemoryBytes: 0,
  physicalMemoryBytes: TEST_PHYSICAL_MEMORY_BYTES,
  procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
};

function createMemoryFileSystem(
  files: ReadonlyMap<string, string | Error>,
  onRead?: (filePath: string) => void,
) {
  return {
    readFileSync(filePath: string) {
      onRead?.(filePath);
      const contents = files.get(filePath);
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
      }
      if (contents instanceof Error) {
        throw contents;
      }
      return contents;
    },
  };
}

type TsdownInvocationParams = NonNullable<Parameters<typeof resolveTsdownBuildInvocation>[0]>;

function resolveTestNodeOptions(params: TsdownInvocationParams) {
  return resolveTsdownBuildInvocation({
    nodeExecPath: "/usr/bin/node",
    npmExecPath: "/tmp/pnpm.cjs",
    env: {},
    ...params,
  }).options.env.NODE_OPTIONS;
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

describe("resolveTsdownBuildInvocation", () => {
  it("parses wrapper help before any tsdown work", () => {
    expect(parseTsdownBuildArgs(["--help"])).toEqual({ forwardedArgs: [], help: true });
    expect(parseTsdownBuildArgs(["--format", "esm"])).toEqual({
      forwardedArgs: ["--format", "esm"],
      help: false,
    });
  });

  it("prints wrapper help without invoking pnpm or tsdown", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/tsdown-build.mts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node --import tsx scripts/tsdown-build.mts");
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

  it("builds AI, packages, runtime, and bounded declarations sequentially", () => {
    const results = resolveTsdownBuildInvocations({
      args: ["--format", "esm"],
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(results).toHaveLength(3 + TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.length);
    expect(results[0]?.args).toEqual(
      expect.arrayContaining(["--config", "tsdown.ai.config.ts", "--format", "esm"]),
    );
    const filters = results.slice(1).map((result) => {
      const filterIndex = result.args.indexOf("--filter");
      return result.args[filterIndex + 1];
    });
    expect(filters).toEqual([
      TSDOWN_PACKAGE_CONFIG_GROUP,
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
    ]);
    for (const result of results.slice(1)) {
      expect(result.args).toEqual(expect.arrayContaining(["--format", "esm"]));
    }
  });

  it.each([
    ["environment", [], { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" }],
    ["CLI", ["--no-dts"], {}],
  ])("keeps %s no-DTS builds in one main invocation", (_source, args, env) => {
    const results = resolveTsdownBuildInvocations({
      args,
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env,
      ...NO_MEMORY_LIMIT,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.args).toEqual(expect.arrayContaining(["--config", "tsdown.ai.config.ts"]));
    expect(results[1]?.args).not.toContain("--filter");
  });

  it("serializes declaration graphs when --dts overrides the no-DTS environment", () => {
    const results = resolveTsdownBuildInvocations({
      args: ["--dts"],
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
      ...NO_MEMORY_LIMIT,
    });

    expect(results).toHaveLength(3 + TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.length);
    expect(results[1]?.args).toEqual(expect.arrayContaining(["--filter", "openclaw-packages"]));
    expect(results[2]?.args).toEqual(expect.arrayContaining(["--filter", "openclaw-unified"]));
    expect(results.at(-1)?.args).toEqual(
      expect.arrayContaining(["--filter", TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.at(-1)]),
    );
  });

  it("expands the full-build unified selector into one runtime and bounded declaration graphs", () => {
    const results = resolveTsdownBuildInvocations({
      args: [
        "--config",
        "tsdown.config.ts",
        "--filter",
        TSDOWN_UNIFIED_CONFIG_GROUP,
        "--format",
        "esm",
      ],
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(results).toHaveLength(1 + TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.length);
    expect(
      results.map((result) => {
        const filterIndex = result.args.indexOf("--filter");
        return result.args[filterIndex + 1];
      }),
    ).toEqual([TSDOWN_UNIFIED_CONFIG_GROUP, ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS]);
    for (const result of results) {
      expect(result.args).toEqual(expect.arrayContaining(["--config", "tsdown.config.ts"]));
      expect(result.args).toEqual(expect.arrayContaining(["--format", "esm"]));
    }
  });

  it.each(["tsdown.config.ts", "."])(
    "keeps cleanup one-time when canonical config %s is serialized",
    (config) => {
      const args = ["--config", config, "--clean"];
      const results = resolveTsdownBuildInvocations({
        args,
        env: {},
        ...NO_MEMORY_LIMIT,
      });

      expect(resolveTsdownCleanOutputRoots(args)).toEqual(
        resolveTsdownCleanOutputRoots(["--config", "tsdown.config.ts", "--clean"]),
      );
      expect(results.length).toBeGreaterThan(1);
      for (const result of results) {
        expect(result.args).toContain("--no-clean");
        expect(result.args).not.toContain("--clean");
      }
    },
  );

  it("preserves explicit cleanup for a custom config-owned output", () => {
    const [result] = resolveTsdownBuildInvocations({
      args: ["--config", "custom.tsdown.config.ts", "--clean"],
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(result).toBeDefined();
    expect(result?.args.indexOf("--clean")).toBeGreaterThan(
      result?.args.indexOf("--no-clean") ?? -1,
    );
  });

  it("cleans an explicit output directory once before serialized children", () => {
    const args = ["--out-dir", "tmp/custom-dist", "--clean"];
    const results = resolveTsdownBuildInvocations({ args, env: {}, ...NO_MEMORY_LIMIT });

    expect(resolveTsdownCleanOutputRoots(args)).toEqual(["tmp/custom-dist"]);
    expect(results.length).toBeGreaterThan(1);
    for (const result of results) {
      expect(result.args).toContain("--no-clean");
      expect(result.args).not.toContain("--clean");
    }
  });

  it("sorts explicit known filters into canonical dependency order", () => {
    const results = resolveTsdownBuildInvocations({
      args: [
        "--config",
        "tsdown.config.ts",
        "--filter",
        "openclaw-dts-base",
        "--filter",
        TSDOWN_PACKAGE_CONFIG_GROUP,
      ],
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(
      results.map((result) => {
        const filterIndex = result.args.indexOf("--filter");
        return result.args[filterIndex + 1];
      }),
    ).toEqual([TSDOWN_PACKAGE_CONFIG_GROUP, "openclaw-dts-base"]);
  });

  it.each([
    ["long filter", ["--filter", "openclaw-unified"]],
    ["long assigned filter", ["--filter=openclaw-unified"]],
    ["short filter", ["-F", "openclaw-unified"]],
    ["short assigned filter", ["-F=openclaw-unified"]],
  ])("keeps a caller-provided %s in one main invocation", (_label, args) => {
    const results = resolveTsdownBuildInvocations({
      args,
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.args).not.toEqual(expect.arrayContaining(args));
    expect(results[1]?.args.slice(-args.length)).toEqual(args);
  });

  it.each([
    ["long config", ["--config", "custom.tsdown.config.ts"]],
    ["long assigned config", ["--config=custom.tsdown.config.ts"]],
    ["short config", ["-c", "custom.tsdown.config.ts"]],
    ["short assigned config", ["-c=custom.tsdown.config.ts"]],
    ["config disabled", ["--no-config", "src/index.ts"]],
  ])("keeps a caller-provided %s in one unfiltered invocation", (_label, args) => {
    const results = resolveTsdownBuildInvocations({
      args,
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      ...NO_MEMORY_LIMIT,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.args.slice(-args.length)).toEqual(args);
  });

  it.each([
    ["long", ["--watch"]],
    ["long path", ["--watch", "src"]],
    ["long assigned", ["--watch=src"]],
    ["short", ["-w"]],
    ["short assigned", ["-w=src"]],
  ])("keeps an explicit-config %s watch in one owning process", (_label, watchArgs) => {
    const args = ["--config", "tsdown.config.ts", ...watchArgs];
    const results = resolveTsdownBuildInvocations({ args, env: {}, ...NO_MEMORY_LIMIT });

    expect(results).toHaveLength(1);
    expect(results[0]?.args.slice(-args.length)).toEqual(args);
  });

  it.each([["--watch"], ["-w"]])(
    "rejects default %s mode before splitting long-lived watchers",
    (watchArg) => {
      expect(() =>
        resolveTsdownBuildInvocations({ args: [watchArg], env: {}, ...NO_MEMORY_LIMIT }),
      ).toThrow("watch mode requires an explicit --config/-c or --no-config selector");
    },
  );

  it("keeps an explicit config-free positional entry in one small plan", () => {
    const args = ["--no-config", "packages/normalization-core/src/mountinfo-path.ts"];
    const plan = resolveTsdownBuildPlan({
      args,
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(plan.heapShortfall).toBeNull();
    expect(plan.invocations).toHaveLength(1);
    expect(plan.invocations[0]?.args.slice(-args.length)).toEqual(args);
  });

  it("preserves canonical admission and serialization for config-enabled positional entries", () => {
    const args = ["packages/normalization-core/src/mountinfo-path.ts"];
    const plan = resolveTsdownBuildPlan({
      args,
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(plan.heapShortfall?.fatal).toBe(true);
    expect(plan.invocations.length).toBeGreaterThan(1);
    for (const invocation of plan.invocations) {
      expect(invocation.args.at(-1)).toBe(args[0]);
    }
  });

  it("keeps an explicit config-free positional-entry watcher in one owning process", () => {
    const args = ["--no-config", "packages/normalization-core/src/mountinfo-path.ts", "--watch"];
    const invocations = resolveTsdownBuildInvocations({ args, env: {}, ...NO_MEMORY_LIMIT });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args.slice(-args.length)).toEqual(args);
  });

  it("freezes one heap budget for admission and every full-build invocation", () => {
    let memoryReads = 0;
    const result = resolveTsdownBuildPlan({
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      cgroupMemoryLimitPaths: ["/test/memory.max"],
      fs: {
        readFileSync(filePath: string) {
          if (filePath !== "/test/memory.max") {
            throw new Error(`unexpected path ${filePath}`);
          }
          memoryReads += 1;
          return `${(memoryReads === 1 ? 5 : 4) * 1024 * 1024 * 1024}\n`;
        },
      },
    });

    expect(memoryReads).toBe(1);
    expect(result.heapShortfall).toBeNull();
    expect(result.invocations).not.toHaveLength(0);
    for (const invocation of result.invocations) {
      expect(invocation.options.env.NODE_OPTIONS).toBe("--max-old-space-size=4352");
    }
  });

  it.each([
    ["custom config", ["--config", "custom.tsdown.config.ts"]],
    ["disabled config", ["--no-config", "src/index.ts"]],
    ["package-only filtered build", ["--filter", TSDOWN_PACKAGE_CONFIG_GROUP]],
  ])("does not apply full-build admission to a %s", (_label, args) => {
    const result = resolveTsdownBuildPlan({
      args,
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.heapShortfall).toBeNull();
  });

  it("applies admission to the direct unified declaration plan", () => {
    const result = resolveTsdownBuildPlan({
      args: ["--config", "tsdown.config.ts", "--filter", TSDOWN_UNIFIED_CONFIG_GROUP],
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.heapShortfall?.fatal).toBe(true);
    expect(result.invocations).toHaveLength(1 + TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.length);
    expect(
      resolveTsdownBuildPlan({
        args: ["--filter", TSDOWN_UNIFIED_CONFIG_GROUP],
        env: {},
        cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
      }).heapShortfall?.fatal,
    ).toBe(true);
  });

  it.each([
    ["long", ["--filter", TSDOWN_PACKAGE_CONFIG_GROUP, "--filter", TSDOWN_UNIFIED_CONFIG_GROUP]],
    [
      "long reversed",
      ["--filter", TSDOWN_UNIFIED_CONFIG_GROUP, "--filter", TSDOWN_PACKAGE_CONFIG_GROUP],
    ],
    [
      "long assigned",
      [`--filter=${TSDOWN_PACKAGE_CONFIG_GROUP}`, `--filter=${TSDOWN_UNIFIED_CONFIG_GROUP}`],
    ],
    ["short", ["-F", TSDOWN_PACKAGE_CONFIG_GROUP, "-F", TSDOWN_UNIFIED_CONFIG_GROUP]],
    ["short reversed", ["-F", TSDOWN_UNIFIED_CONFIG_GROUP, "-F", TSDOWN_PACKAGE_CONFIG_GROUP]],
    ["short assigned", [`-F=${TSDOWN_PACKAGE_CONFIG_GROUP}`, `-F=${TSDOWN_UNIFIED_CONFIG_GROUP}`]],
  ])("admits repeated %s filters and cleans the complete output set", (_label, args) => {
    const result = resolveTsdownBuildPlan({
      args,
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.heapShortfall?.fatal).toBe(true);
    expect(
      result.invocations
        .slice(1)
        .map((invocation) =>
          invocation.args.filter(
            (_arg, index, invocationArgs) => invocationArgs[index - 1] === "--filter",
          ),
        ),
    ).toEqual([[TSDOWN_PACKAGE_CONFIG_GROUP], [TSDOWN_UNIFIED_CONFIG_GROUP]]);
    expect(new Set(resolveTsdownCleanOutputRoots(args))).toEqual(new Set(listTsdownOutputRoots()));
  });

  it.each([
    ["explicit", ["--config", "tsdown.config.ts"]],
    ["default", []],
  ])("preserves tsdown OR semantics for %s config with an unmatched filter", (_label, config) => {
    const args = [...config, "--filter", TSDOWN_PACKAGE_CONFIG_GROUP, "--filter", "missing-group"];

    const results = resolveTsdownBuildInvocations({ args, env: {}, ...NO_MEMORY_LIMIT });

    expect(results).toHaveLength(config.length === 0 ? 2 : 1);
    expect(results.at(-1)?.args.slice(-args.length)).toEqual(args);
  });

  it("applies admission when tsdown selects the root config by cwd", () => {
    const args = ["--config", "tsdown.config.ts", "--filter", "."];
    const result = resolveTsdownBuildPlan({
      args,
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.heapShortfall?.fatal).toBe(true);
    expect(
      result.invocations.map((invocation) => {
        const filterIndex = invocation.args.indexOf("--filter");
        return invocation.args[filterIndex + 1];
      }),
    ).toEqual([
      TSDOWN_PACKAGE_CONFIG_GROUP,
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
    ]);
    expect(new Set(resolveTsdownCleanOutputRoots(args))).toEqual(
      new Set(listTsdownOutputRoots().filter((root) => root !== "packages/ai/dist")),
    );
    expect(
      new Set(resolveTsdownCleanOutputRoots([...args, "--filter", TSDOWN_PACKAGE_CONFIG_GROUP])),
    ).toEqual(new Set(listTsdownOutputRoots().filter((root) => root !== "packages/ai/dist")));

    const defaultConfigPlan = resolveTsdownBuildPlan({
      args: ["--filter=."],
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    expect(defaultConfigPlan.heapShortfall?.fatal).toBe(true);
    expect(defaultConfigPlan.invocations).toHaveLength(1 + result.invocations.length);
    expect(
      defaultConfigPlan.invocations.slice(1).map((invocation) => {
        return invocation.args.filter(
          (_arg, index, invocationArgs) => invocationArgs[index - 1] === "--filter",
        );
      }),
    ).toEqual([
      [TSDOWN_PACKAGE_CONFIG_GROUP],
      [TSDOWN_UNIFIED_CONFIG_GROUP],
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.map((group) => [group]),
    ]);
    expect(
      new Set(
        resolveTsdownCleanOutputRoots(["--filter=.", `--filter=${TSDOWN_PACKAGE_CONFIG_GROUP}`]),
      ),
    ).toEqual(new Set(listTsdownOutputRoots()));
  });

  it.each([
    ["--config", "tsdown.config.ts"],
    ["--config=tsdown.config.ts"],
    ["-c", "tsdown.config.ts"],
    ["-c=tsdown.config.ts"],
    ["--config", "."],
    ["--config=."],
    ["-c", "."],
    ["-c=."],
  ])("applies admission to canonical config form %j", (...args) => {
    expect(
      resolveTsdownBuildPlan({
        args,
        env: {},
        cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
      }).heapShortfall?.fatal,
    ).toBe(true);
  });

  it("applies admission to the unfiltered canonical config but not a package-only selector", () => {
    const full = resolveTsdownBuildPlan({
      args: ["--config", "tsdown.config.ts"],
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const packages = resolveTsdownBuildPlan({
      args: ["--config", "tsdown.config.ts", "--filter", TSDOWN_PACKAGE_CONFIG_GROUP],
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(full.heapShortfall?.fatal).toBe(true);
    expect(full.invocations).toHaveLength(2 + TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.length);
    expect(
      full.invocations.map((invocation) => {
        const filterIndex = invocation.args.indexOf("--filter");
        return invocation.args[filterIndex + 1];
      }),
    ).toEqual([
      TSDOWN_PACKAGE_CONFIG_GROUP,
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
    ]);
    expect(packages.heapShortfall).toBeNull();
    expect(packages.invocations).toHaveLength(1);
  });

  it("keeps a full-build dot selector serialized when combined with an unknown filter", () => {
    const result = resolveTsdownBuildPlan({
      args: ["--config", "tsdown.config.ts", "--filter", ".", "--filter", "missing"],
      env: {},
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.heapShortfall?.fatal).toBe(true);
    expect(
      result.invocations.map((invocation) => {
        const filterIndex = invocation.args.indexOf("--filter");
        return invocation.args[filterIndex + 1];
      }),
    ).toEqual([
      TSDOWN_PACKAGE_CONFIG_GROUP,
      TSDOWN_UNIFIED_CONFIG_GROUP,
      ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
    ]);
  });

  it.each([
    ["Docker default", [], { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" }],
    ["CLI override", ["--no-dts"], {}],
  ])("applies the unified-runtime threshold to a %s plan", (_label, args, env) => {
    const result = resolveTsdownBuildPlan({
      args,
      platform: "linux",
      nodeExecPath: "/usr/bin/node",
      npmExecPath: "/tmp/pnpm.cjs",
      env,
      cgroupMemoryLimitBytes: 2 * 1024 * 1024 * 1024,
    });

    expect(result.maxOldSpaceMb).toBe(1280);
    expect(result.heapShortfall?.fatal).toBe(true);
    expect(result.invocations).toHaveLength(2);
  });

  it("restores declaration-build admission when --dts overrides the Docker default", () => {
    const result = resolveTsdownBuildPlan({
      args: ["--dts"],
      env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
      cgroupMemoryLimitBytes: 2 * 1024 * 1024 * 1024,
    });

    expect(result.heapShortfall?.fatal).toBe(true);
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

  it.each([
    {
      title: "keeps inherited Windows tsdown heap settings at the Windows build cap",
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      pnpmPath: "C:\\repo\\pnpm.cjs",
      nodeOptions: "--trace-warnings --max-old-space-size=8192",
      expectedNodeOptions: "--trace-warnings --max-old-space-size=8192",
    },
    {
      title: "clamps explicit Windows tsdown heap settings to the Windows build cap",
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      pnpmPath: "C:\\repo\\pnpm.cjs",
      nodeOptions: "--trace-warnings --max-old-space-size=12288",
      expectedNodeOptions: "--trace-warnings --max-old-space-size=8192",
    },
    {
      title: "preserves explicit tsdown heap settings",
      platform: "linux",
      execPath: "/usr/bin/node",
      pnpmPath: "/tmp/pnpm.cjs",
      nodeOptions: "--trace-warnings --max-old-space-size=12288",
      expectedNodeOptions: "--trace-warnings --max-old-space-size=12288",
    },
    {
      title: "raises inherited lower tsdown heap settings to the build default",
      platform: "linux",
      execPath: "/usr/bin/node",
      pnpmPath: "/tmp/pnpm.cjs",
      nodeOptions: "--trace-warnings --max-old-space-size=4096",
      expectedNodeOptions: "--trace-warnings --max-old-space-size=12288",
    },
    {
      title: "raises split inherited lower tsdown heap settings to the build default",
      platform: "linux",
      execPath: "/usr/bin/node",
      pnpmPath: "/tmp/pnpm.cjs",
      nodeOptions: "--trace-warnings --max-old-space-size 4096",
      expectedNodeOptions: "--trace-warnings --max-old-space-size=12288",
    },
  ])("$title", ({ platform, execPath, pnpmPath, nodeOptions, expectedNodeOptions }) => {
    const result = resolveTsdownBuildInvocation({
      platform,
      nodeExecPath: execPath,
      npmExecPath: pnpmPath,
      env: { NODE_OPTIONS: nodeOptions },
      ...NO_MEMORY_LIMIT,
    });

    expect(result.options.env.NODE_OPTIONS).toBe(expectedNodeOptions);
  });

  it("keeps default tsdown heap below the container memory limit", () => {
    expect(resolveTestNodeOptions({ cgroupMemoryLimitBytes: 7 * 1024 * 1024 * 1024 })).toBe(
      "--max-old-space-size=6400",
    );
  });

  it("deducts memory already used by a shared limiting cgroup", () => {
    const cgroupFiles = new Map([
      ["/test/memory.max", `${5 * 1024 * 1024 * 1024}\n`],
      ["/test/memory.current", `${1664 * 1024 * 1024}\n`],
      [
        "/test/memory.stat",
        `anon ${512 * 1024 * 1024}\nshmem ${256 * 1024 * 1024}\nfile ${768 * 1024 * 1024}\ninactive_file ${768 * 1024 * 1024}\nkernel ${128 * 1024 * 1024}\n`,
      ],
    ]);
    const fsFixture = createMemoryFileSystem(cgroupFiles);
    const result = resolveTsdownBuildPlan({
      env: {},
      cgroupMemoryLimitPaths: ["/test/memory.max"],
      physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
      processResidentMemoryBytes: 64 * 1024 * 1024,
      procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
      fs: fsFixture,
    });

    // Credit 768 MiB of inactive file pages and this wrapper's 64 MiB RSS. Anonymous memory,
    // shmem, and the remaining 128 MiB kernel charge all compete with the child heap.
    expect(result.maxOldSpaceMb).toBe(3520);
    expect(result.heapShortfall?.fatal).toBe(true);

    cgroupFiles.set("/test/memory.current", `${832 * 1024 * 1024}\n`);
    cgroupFiles.set(
      "/test/memory.stat",
      `anon ${64 * 1024 * 1024}\nshmem 0\nfile ${768 * 1024 * 1024}\ninactive_file ${768 * 1024 * 1024}\nkernel 0\n`,
    );
    const isolated = resolveTsdownBuildPlan({
      env: {},
      cgroupMemoryLimitPaths: ["/test/memory.max"],
      physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
      processResidentMemoryBytes: 64 * 1024 * 1024,
      procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
      fs: fsFixture,
    });
    expect(isolated.maxOldSpaceMb).toBe(4352);
    expect(isolated.heapShortfall).toBeNull();
  });

  it("refuses to start when the host budget cannot fit the build", () => {
    // 1500MiB minus the 768MiB headroom leaves 732MB, well under what the packages pass needs.
    const shortfall = describeInsufficientTsdownHeap({
      env: {},
      cgroupMemoryLimitBytes: 1500 * 1024 * 1024,
    });

    expect(shortfall?.fatal).toBe(true);
    expect(shortfall?.message).toContain("resolved OpenClaw build heap is 732MB");
    expect(shortfall?.message).toContain("OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=<MB>");
  });

  it("refuses a host whose slice cannot hold the whole-build peak", () => {
    // A 4GiB slice resolves a 3328MB heap and clears the early invocations, then dies partway
    // through the third: the binding constraint is the 4730MiB whole-build peak, not one pass.
    expect(
      describeInsufficientTsdownHeap({ env: {}, cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024 })
        ?.fatal,
    ).toBe(true);
  });

  it("points Docker refusals at the public build heap override", () => {
    const shortfall = describeInsufficientTsdownHeap({
      env: { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "" },
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(shortfall?.fatal).toBe(true);
    expect(shortfall?.message).toContain("set OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=<MB>");
    expect(shortfall?.message).not.toContain("set OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=<MB>");
  });

  it("admits the smallest slice measured to complete a full build", () => {
    expect(
      describeInsufficientTsdownHeap({ env: {}, cgroupMemoryLimitBytes: 5 * 1024 * 1024 * 1024 }),
    ).toBeNull();
  });

  it("uses an explicit heap override as the operator's opt-in for the complete plan", () => {
    const plan = resolveTsdownBuildPlan({
      env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "4096" },
      cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(plan.heapShortfall?.fatal).toBe(false);
    expect(plan.heapShortfall?.message).toContain(
      "Continuing because OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB explicitly requests 4096MB",
    );
    for (const invocation of plan.invocations) {
      expect(invocation.options.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    }
  });

  it("refuses a fatal plan before cleanup and lets an explicit override proceed", () => {
    const fatalCleanup = vi.fn();
    const fatalReport = vi.fn();
    const fatalPlan = prepareTsdownBuildExecution(
      { env: {}, cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024 },
      { cleanup: fatalCleanup, reportShortfall: fatalReport },
    );

    expect(fatalPlan).toBeNull();
    expect(fatalReport).toHaveBeenCalledWith(expect.objectContaining({ fatal: true }));
    expect(fatalCleanup).not.toHaveBeenCalled();

    const optedInCleanup = vi.fn();
    const optedInPlan = prepareTsdownBuildExecution(
      {
        env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "4096" },
        cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
      },
      { cleanup: optedInCleanup },
    );

    expect(optedInPlan).not.toBeNull();
    expect(optedInCleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ["repeated named configs", ["--config", "custom.ts", "-c=tsdown.config.ts"]],
    ["config then no-config", ["--config", "tsdown.config.ts", "--no-config", "src/index.ts"]],
    ["no-config then config", ["--no-config", "src/index.ts", "-c=tsdown.config.ts"]],
  ])("rejects %s before cleanup", (_label, args) => {
    const cleanup = vi.fn();

    expect(() =>
      prepareTsdownBuildExecution(
        {
          args,
          env: {},
          ...NO_MEMORY_LIMIT,
        },
        { cleanup },
      ),
    ).toThrow("tsdown build accepts only one --config/-c/--no-config selector");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["missing output directory", ["--out-dir", "--watch"]],
    ["empty assigned output directory", ["--out-dir="]],
    ["repeated output directories", ["--out-dir", "first", "-d=second"]],
  ])("rejects %s before cleanup", (_label, args) => {
    const cleanup = vi.fn();

    expect(() =>
      prepareTsdownBuildExecution(
        {
          args,
          env: {},
          ...NO_MEMORY_LIMIT,
        },
        { cleanup },
      ),
    ).toThrow(/tsdown build .* --out-dir\/-d value/u);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["bare long filter", ["--filter"]],
    ["bare short filter", ["-F"]],
    ["empty assigned filter", ["--filter="]],
    ["missing repeated filter", ["--filter", "openclaw-packages", "-F", "--watch"]],
  ])("rejects %s before cleanup", (_label, args) => {
    const cleanup = vi.fn();

    expect(() =>
      prepareTsdownBuildExecution(
        {
          args,
          env: {},
          ...NO_MEMORY_LIMIT,
        },
        { cleanup },
      ),
    ).toThrow("tsdown build requires one concrete --filter/-F value");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("stays silent when the host budget fits the build", () => {
    expect(
      describeInsufficientTsdownHeap({ env: {}, cgroupMemoryLimitBytes: 8 * 1024 * 1024 * 1024 }),
    ).toBeNull();
  });

  it("never sizes the heap above a cgroup limit smaller than the old floor", () => {
    // A floor applied on top of a real limit yields a heap the cgroup cannot honour, so the
    // build is OOM-killed instead of merely running smaller.
    // 1500 MiB budget minus the 768 MiB headroom, not the former 2048 MiB floor.
    expect(resolveTestNodeOptions({ cgroupMemoryLimitBytes: 1500 * 1024 * 1024 })).toBe(
      "--max-old-space-size=732",
    );
  });

  it.each([4096, 1024 * 1024 - 1])(
    "keeps a %i-byte cgroup limit bounded instead of treating it as unbounded",
    (cgroupMemoryLimitBytes) => {
      expect(resolveTestNodeOptions({ cgroupMemoryLimitBytes })).toBe("--max-old-space-size=1");
    },
  );

  it("keeps a parsed zero-byte cgroup limit bounded", () => {
    expect(
      resolveTestNodeOptions({
        cgroupMemoryLimitPaths: ["/test/memory.max"],
        fs: createMemoryFileSystem(new Map([["/test/memory.max", "0\n"]])),
      }),
    ).toBe("--max-old-space-size=1");
  });

  it("uses Node's constrained-memory result as a canonical cgroup candidate", () => {
    expect(
      resolveTestNodeOptions({
        constrainedMemoryBytes: 5 * 1024 * 1024 * 1024,
        cgroupMemoryLimitPaths: [],
      }),
    ).toBe("--max-old-space-size=4352");
  });

  it("uses physical memory when cgroups and procfs are unavailable", () => {
    const result = resolveTsdownBuildPlan({
      platform: "darwin",
      env: {},
      constrainedMemoryBytes: 0,
      cgroupMemoryLimitPaths: [],
      availableMemoryBytes: 4 * 1024 * 1024 * 1024,
      procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
      physicalMemoryBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.maxOldSpaceMb).toBe(3328);
    expect(result.heapShortfall?.fatal).toBe(true);
  });

  it("does not gate macOS builds on Node's instantaneous free-page count", () => {
    const result = resolveTsdownBuildPlan({
      platform: "darwin",
      env: {},
      cgroupMemoryLimitPaths: [],
      constrainedMemoryBytes: 0,
      procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
      physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
    });

    expect(result.maxOldSpaceMb).toBe(12288);
    expect(result.heapShortfall).toBeNull();
  });

  it("caps a non-cgrouped build by currently available host memory", () => {
    const result = resolveTsdownBuildPlan({
      env: {},
      cgroupMemoryLimitPaths: [],
      constrainedMemoryBytes: 0,
      procMemTotalBytes: 16 * 1024 * 1024 * 1024,
      physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
      availableMemoryBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.maxOldSpaceMb).toBe(3328);
    expect(result.heapShortfall?.fatal).toBe(true);
  });

  it("caps a finite cgroup by host MemAvailable and preserves zero", () => {
    const base = {
      env: {},
      cgroupMemoryLimitBytes: 8 * 1024 * 1024 * 1024,
      physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
      platform: "linux",
      procMeminfoPath: "/test/meminfo",
      fs: createMemoryFileSystem(
        new Map([["/test/meminfo", "MemTotal:       16777216 kB\nMemAvailable:    4194304 kB\n"]]),
      ),
    };

    expect(resolveTsdownBuildPlan(base).maxOldSpaceMb).toBe(3328);
    expect(resolveTsdownBuildPlan({ ...base, availableMemoryBytes: 0 }).maxOldSpaceMb).toBe(1);
  });

  it("caps an oversized cgroup limit by physical memory", () => {
    const result = resolveTsdownBuildPlan({
      env: {},
      cgroupMemoryLimitBytes: 64 * 1024 * 1024 * 1024,
      procMeminfoPath: "/openclaw-test-missing-proc-meminfo",
      physicalMemoryBytes: 4 * 1024 * 1024 * 1024,
    });

    expect(result.maxOldSpaceMb).toBe(3328);
    expect(result.heapShortfall?.fatal).toBe(true);
  });

  it("caps the tsdown heap using the process's own cgroup slice budget", () => {
    const slicePath = "/user.slice/user-999.slice/user@999.service";
    // Only the ancestor slice carries a budget; the leaf unit and the v2 root
    // are unlimited, which is what a systemd-managed build actually looks like.
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", `0::${slicePath}/app.slice/openclaw-main-update.service\n`],
      [`/sys/fs/cgroup${slicePath}/memory.high`, `${5 * 1024 * 1024 * 1024}\n`],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      fs: createMemoryFileSystem(cgroupFiles),
    });

    // 5 GiB slice budget minus the 768 MiB build headroom.
    expect(nodeOptions).toBe("--max-old-space-size=4352");
  });

  it("uses the tightest finite cgroup ancestor when the leaf is also bounded", () => {
    const leafPath = "/user.slice/openclaw.service";
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", `0::${leafPath}\n`],
      [`/sys/fs/cgroup${leafPath}/memory.max`, `${6 * 1024 * 1024 * 1024}\n`],
      ["/sys/fs/cgroup/user.slice/memory.max", `${5 * 1024 * 1024 * 1024}\n`],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=4352");
  });

  it("uses a resolved v1 memory limit when a hybrid host's v2 view is inherited", () => {
    const slicePath = "/user.slice/user-999.slice";
    // A legacy/hybrid host publishes the budget through the v1 memory controller, and the
    // unified record carries no controllers, so only the v1 walk can find this limit.
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", `0::/\n7:memory:${slicePath}/openclaw-main-update.service\n`],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 /.. /sys/fs/cgroup/unified rw,nosuid - cgroup2 cgroup2 rw\n" +
          "31 25 0:27 / /sys/fs/cgroup/memory rw,nosuid - cgroup cgroup rw,memory\n",
      ],
      [`/sys/fs/cgroup/memory${slicePath}/memory.use_hierarchy`, "1\n"],
      ["/sys/fs/cgroup/memory/user.slice/memory.use_hierarchy", "0\n"],
      [`/sys/fs/cgroup/memory${slicePath}/memory.limit_in_bytes`, `${6 * 1024 * 1024 * 1024}\n`],
      [`/sys/fs/cgroup/memory${slicePath}/memory.usage_in_bytes`, `${1280 * 1024 * 1024}\n`],
      [
        `/sys/fs/cgroup/memory${slicePath}/memory.stat`,
        `rss ${64 * 1024 * 1024}\ntotal_rss ${512 * 1024 * 1024}\ncache ${768 * 1024 * 1024}\ntotal_inactive_file ${768 * 1024 * 1024}\n`,
      ],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      processResidentMemoryBytes: 64 * 1024 * 1024,
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=4928");
  });

  it("uses host memory when hybrid v1 memory is visibly unlimited and v2 is inherited", () => {
    const slicePath = "/user.slice/user-999.slice";
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", `0::/\n7:memory:${slicePath}/openclaw-main-update.service\n`],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 /.. /sys/fs/cgroup/unified rw,nosuid - cgroup2 cgroup2 rw\n" +
          "31 25 0:27 / /sys/fs/cgroup/memory rw,nosuid - cgroup cgroup rw,memory\n",
      ],
      [`/sys/fs/cgroup/memory${slicePath}/memory.use_hierarchy`, "1\n"],
      ["/sys/fs/cgroup/memory/user.slice/memory.use_hierarchy", "0\n"],
      [`/sys/fs/cgroup/memory${slicePath}/memory.limit_in_bytes`, "9223372036854771712\n"],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      availableMemoryBytes: 16 * 1024 * 1024 * 1024,
      physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
      procMemTotalBytes: 16 * 1024 * 1024 * 1024,
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=12288");
  });

  it("refuses a default heap when an inherited namespace mount hides the process limit", () => {
    // cgroup_namespaces(7): an inherited mount rooted at "/.." exposes a parent while the
    // process record is relative to a hidden child. The parent cannot prove the child budget.
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/\n7:memory:/hidden.slice\n"],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 /.. /sys/fs/cgroup/unified rw,nosuid - cgroup2 cgroup2 rw\n" +
          "31 25 0:27 / /sys/fs/cgroup/memory rw,nosuid - cgroup cgroup rw,memory\n",
      ],
      ["/sys/fs/cgroup/memory.max", "max\n"],
      ["/proc/meminfo", `MemTotal:       ${16 * 1024 * 1024} kB\n`],
    ]);
    const fsFixture = createMemoryFileSystem(cgroupFiles);

    const result = resolveTsdownBuildPlan({
      env: {},
      fs: fsFixture,
    });

    expect(result.maxOldSpaceMb).toBe(1);
    expect(result.heapShortfall?.fatal).toBe(true);
    expect(result.heapShortfall?.message).toContain(
      "process memory limit is not visible through this cgroup mount namespace",
    );
    expect(result.heapShortfall?.message).toContain(
      "run the build where the process cgroup limit is visible",
    );

    const cleanup = vi.fn();
    const partialPlan = prepareTsdownBuildExecution(
      { args: ["--config", "custom.ts"], env: {}, fs: fsFixture },
      { cleanup },
    );
    expect(partialPlan).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();

    const optedIn = resolveTsdownBuildPlan({
      env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "4096" },
      fs: fsFixture,
    });
    expect(optedIn.maxOldSpaceMb).toBe(4096);
    expect(optedIn.heapShortfall?.fatal).toBe(false);
  });

  it("refuses cleanup when a cgroup record has no readable controller mount", () => {
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/hidden.slice/openclaw.service\n"],
      ["/proc/self/mountinfo", ""],
      ["/proc/meminfo", `MemTotal:       ${16 * 1024 * 1024} kB\n`],
    ]);
    const cleanup = vi.fn();

    const plan = prepareTsdownBuildExecution(
      {
        args: ["--config", "custom.ts"],
        env: {},
        fs: createMemoryFileSystem(cgroupFiles),
      },
      { cleanup },
    );

    expect(plan).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("refuses cleanup when Linux process cgroup membership is unreadable", () => {
    const cgroupFiles = new Map([
      ["/proc/self/mountinfo", "30 25 0:26 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n"],
      [
        "/proc/meminfo",
        `MemTotal:       ${16 * 1024 * 1024} kB\nMemAvailable:   ${16 * 1024 * 1024} kB\n`,
      ],
      ["/sys/fs/cgroup/memory.max", "max\n"],
      ["/sys/fs/cgroup/memory.high", "max\n"],
    ]);
    const cleanup = vi.fn();

    const plan = prepareTsdownBuildExecution(
      {
        args: ["--config", "custom.ts"],
        env: {},
        platform: "linux",
        fs: createMemoryFileSystem(cgroupFiles),
      },
      { cleanup },
    );

    expect(plan).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("uses host memory at an observed unconstrained cgroup-v2 root", () => {
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/\n"],
      ["/proc/self/mountinfo", "30 25 0:26 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n"],
      [
        "/proc/meminfo",
        `MemTotal:       ${16 * 1024 * 1024} kB\nMemAvailable:   ${16 * 1024 * 1024} kB\n`,
      ],
    ]);

    const plan = resolveTsdownBuildPlan({
      env: {},
      fs: createMemoryFileSystem(cgroupFiles),
      physicalMemoryBytes: TEST_PHYSICAL_MEMORY_BYTES,
    });

    expect(plan.maxOldSpaceMb).toBe(12288);
    expect(plan.heapShortfall).toBeNull();
  });

  it("uses host memory when an observed v2 hierarchy disables the memory controller", () => {
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/user.slice/openclaw.service\n"],
      ["/proc/self/mountinfo", "30 25 0:26 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n"],
      [
        "/proc/meminfo",
        `MemTotal:       ${16 * 1024 * 1024} kB\nMemAvailable:   ${16 * 1024 * 1024} kB\n`,
      ],
      ["/sys/fs/cgroup/user.slice/openclaw.service/cgroup.controllers", "cpu io\n"],
    ]);

    const plan = resolveTsdownBuildPlan({
      env: {},
      fs: createMemoryFileSystem(cgroupFiles),
      physicalMemoryBytes: TEST_PHYSICAL_MEMORY_BYTES,
    });

    expect(plan.maxOldSpaceMb).toBe(12288);
    expect(plan.heapShortfall).toBeNull();
  });

  it("does not treat an unreadable v2 limit as a disabled memory controller", () => {
    const cgroupFiles = new Map<string, string | Error>([
      ["/proc/self/cgroup", "0::/user.slice/openclaw.service\n"],
      ["/proc/self/mountinfo", "30 25 0:26 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n"],
      ["/sys/fs/cgroup/user.slice/openclaw.service/cgroup.controllers", "cpu io\n"],
      [
        "/sys/fs/cgroup/user.slice/openclaw.service/memory.max",
        Object.assign(new Error("EACCES: memory.max"), { code: "EACCES" }),
      ],
    ]);

    const plan = resolveTsdownBuildPlan({
      env: {},
      fs: createMemoryFileSystem(cgroupFiles),
      physicalMemoryBytes: TEST_PHYSICAL_MEMORY_BYTES,
    });

    expect(plan.maxOldSpaceMb).toBe(1);
    expect(plan.heapShortfall?.fatal).toBe(true);
  });

  it("fails closed when one applicable cgroup limit is readable and another is not", () => {
    const cgroupDir = "/sys/fs/cgroup/openclaw.service";
    const memoryMaxPath = `${cgroupDir}/memory.max`;
    const memoryHighPath = `${cgroupDir}/memory.high`;
    const cgroupFiles = new Map<string, string | Error>([
      [memoryMaxPath, `${8 * 1024 * 1024 * 1024}\n`],
      [memoryHighPath, Object.assign(new Error(`EACCES: ${memoryHighPath}`), { code: "EACCES" })],
    ]);

    const plan = resolveTsdownBuildPlan({
      env: {},
      cgroupMemoryLimitPaths: [memoryMaxPath, memoryHighPath],
      fs: createMemoryFileSystem(cgroupFiles),
      physicalMemoryBytes: TEST_PHYSICAL_MEMORY_BYTES,
    });

    expect(plan.maxOldSpaceMb).toBe(1);
    expect(plan.heapShortfall?.fatal).toBe(true);
  });

  it("refuses a default heap when a v1 memory record has no matching visible mount", () => {
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "7:memory:/hidden.slice/openclaw.service\n"],
      [
        "/proc/self/mountinfo",
        "31 25 0:27 /other.slice /sys/fs/cgroup/memory rw,nosuid - cgroup cgroup rw,memory\n",
      ],
      ["/proc/meminfo", `MemTotal:       ${16 * 1024 * 1024} kB\n`],
    ]);

    const result = resolveTsdownBuildPlan({
      env: {},
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(result.maxOldSpaceMb).toBe(1);
    expect(result.heapShortfall?.fatal).toBe(true);
    expect(result.heapShortfall?.message).toContain(
      "process memory limit is not visible through this cgroup mount namespace",
    );
  });

  it("rejects parent segments in a cgroup record instead of escaping the mount", () => {
    const pathsRead: string[] = [];
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/../peer.slice\n"],
      ["/proc/self/mountinfo", "30 25 0:26 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n"],
      ["/proc/meminfo", `MemTotal:       ${7 * 1024 * 1024} kB\n`],
    ]);

    const result = resolveTsdownBuildPlan({
      env: {},
      constrainedMemoryBytes: 1024 * 1024 * 1024,
      fs: createMemoryFileSystem(cgroupFiles, (filePath) => pathsRead.push(filePath)),
    });

    expect(result.maxOldSpaceMb).toBe(1);
    expect(result.heapShortfall?.fatal).toBe(true);
    expect(result.heapShortfall?.message).toContain(
      "process memory limit is not visible through this cgroup mount namespace",
    );
    expect(pathsRead.some((filePath) => filePath.includes("/sys/fs/peer.slice"))).toBe(false);
  });

  it("fails closed on an unrelated mounted subtree for a namespace-root record", () => {
    // A "/" record plus a mount rooted elsewhere is not a kernel-proven match, so the
    // limit behind that subtree may belong to an unrelated cgroup while this process's
    // real limit stays hidden. Neither that limit nor host memory is safe for admission.
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/\n"],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 /docker/2f1a9c /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n",
      ],
      ["/sys/fs/cgroup/memory.max", `${5 * 1024 * 1024 * 1024}\n`],
    ]);

    const result = resolveTsdownBuildPlan({
      env: {},
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(result.maxOldSpaceMb).toBe(1);
    expect(result.heapShortfall?.fatal).toBe(true);
    expect(result.heapShortfall?.message).toContain(
      "process memory limit is not visible through this cgroup mount namespace",
    );
  });

  it("caps the tsdown heap when the cgroup mount point is octal-escaped in mountinfo", () => {
    const slicePath = "/user.slice/user-999.slice/user@999.service";
    // The kernel escapes a space in the mount point as \040. Matching the field
    // verbatim misses this mount, and heap sizing silently falls back to host memory.
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", `0::${slicePath}/app.slice/openclaw-main-update.service\n`],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 / /sys/fs/cgroup\\040dir rw,nosuid - cgroup2 cgroup2 rw\n",
      ],
      [`/sys/fs/cgroup dir${slicePath}/memory.high`, `${5 * 1024 * 1024 * 1024}\n`],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      fs: createMemoryFileSystem(cgroupFiles),
    });

    // 5 GiB slice budget minus the 768 MiB build headroom.
    expect(nodeOptions).toBe("--max-old-space-size=4352");
  });

  it("translates an octal-escaped cgroup mount root before reading the limit", () => {
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/user.slice/user 999.slice/openclaw.service\n"],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 /user.slice/user\\040999.slice /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n",
      ],
      ["/sys/fs/cgroup/openclaw.service/memory.high", `${5 * 1024 * 1024 * 1024}\n`],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=4352");
  });

  it("caps the tsdown heap when v1 controllers are co-mounted at the cgroup root", () => {
    const slicePath = "/user.slice/user-999.slice";
    // Co-mounted v1 puts memory.limit_in_bytes under the slice directly, with no
    // per-controller directory, so the mount point has to come from mountinfo.
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", `2:memory,cpu,cpuacct:${slicePath}/openclaw-main-update.service\n`],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 / /sys/fs/cgroup rw,nosuid - cgroup cgroup rw,memory,cpu,cpuacct\n",
      ],
      [`/sys/fs/cgroup${slicePath}/memory.use_hierarchy`, "1\n"],
      ["/sys/fs/cgroup/user.slice/memory.use_hierarchy", "0\n"],
      [`/sys/fs/cgroup${slicePath}/memory.limit_in_bytes`, `${5 * 1024 * 1024 * 1024}\n`],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=4352");
  });

  it("ignores a co-mounted cgroup-v1 soft limit when the hard limit is unbounded", () => {
    const slicePath = "/user.slice/user-999.slice";
    const cgroupFiles = new Map([
      [`/proc/self/cgroup`, `2:memory,cpu:${slicePath}/openclaw-main-update.service\n`],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 / /sys/fs/cgroup rw,nosuid - cgroup cgroup rw,memory,cpu\n",
      ],
      [`/sys/fs/cgroup${slicePath}/memory.use_hierarchy`, "1\n"],
      ["/sys/fs/cgroup/user.slice/memory.use_hierarchy", "0\n"],
      [`/sys/fs/cgroup${slicePath}/memory.soft_limit_in_bytes`, `${5 * 1024 * 1024 * 1024}\n`],
      [`/sys/fs/cgroup${slicePath}/memory.limit_in_bytes`, "9223372036854771712\n"],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      // Node/libuv reports the v1 soft limit as constrained memory. The owner walk must
      // discard that advisory candidate and use only the hard limit plus host memory.
      constrainedMemoryBytes: 5 * 1024 * 1024 * 1024,
      procMemTotalBytes: 16 * 1024 * 1024 * 1024,
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=12288");
  });

  it("preserves process rlimits while ignoring a cgroup-v1 soft limit", () => {
    const slicePath = "/user.slice/user-999.slice";
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", `2:memory:${slicePath}/openclaw-main-update.service\n`],
      ["/proc/self/mountinfo", "30 25 0:26 / /sys/fs/cgroup rw,nosuid - cgroup cgroup rw,memory\n"],
      [
        "/proc/self/limits",
        `Max data size            ${4 * 1024 * 1024 * 1024}        unlimited            bytes\nMax address space        ${6 * 1024 * 1024 * 1024}        unlimited            bytes\n`,
      ],
      [`/sys/fs/cgroup${slicePath}/memory.use_hierarchy`, "1\n"],
      ["/sys/fs/cgroup/user.slice/memory.use_hierarchy", "0\n"],
      [`/sys/fs/cgroup${slicePath}/memory.limit_in_bytes`, "9223372036854771712\n"],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      platform: "linux",
      constrainedMemoryBytes: 5 * 1024 * 1024 * 1024,
      procMemTotalBytes: 16 * 1024 * 1024 * 1024,
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=3328");
  });

  it("ignores a cgroup-v1 parent limit when hierarchy accounting is disabled", () => {
    const leafPath = "/parent/leaf";
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", `2:memory:${leafPath}\n`],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 / /sys/fs/cgroup/memory rw,nosuid - cgroup cgroup rw,memory\n",
      ],
      [`/sys/fs/cgroup/memory${leafPath}/memory.limit_in_bytes`, `${8 * 1024 * 1024 * 1024}\n`],
      ["/sys/fs/cgroup/memory/parent/memory.use_hierarchy", "0\n"],
      ["/sys/fs/cgroup/memory/parent/memory.limit_in_bytes", `${4 * 1024 * 1024 * 1024}\n`],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=7424");
  });

  it("refuses cleanup when cgroup-v1 hierarchy metadata is unreadable", () => {
    const cgroupFiles = new Map<string, string | Error>([
      ["/proc/self/cgroup", "7:memory:/parent/leaf\n"],
      [
        "/proc/self/mountinfo",
        "31 25 0:27 / /sys/fs/cgroup/memory rw,nosuid - cgroup cgroup rw,memory\n",
      ],
      ["/sys/fs/cgroup/memory/parent/leaf/memory.limit_in_bytes", "9223372036854771712\n"],
      ["/sys/fs/cgroup/memory/memory.use_hierarchy", "0\n"],
      [
        "/sys/fs/cgroup/memory/parent/memory.use_hierarchy",
        Object.assign(new Error("EACCES: memory.use_hierarchy"), { code: "EACCES" }),
      ],
      [
        "/proc/meminfo",
        `MemTotal:       ${16 * 1024 * 1024} kB\nMemAvailable:   ${16 * 1024 * 1024} kB\n`,
      ],
    ]);
    const cleanup = vi.fn();

    const plan = prepareTsdownBuildExecution(
      {
        args: ["--config", "custom.ts"],
        env: {},
        platform: "linux",
        fs: createMemoryFileSystem(cgroupFiles),
      },
      { cleanup },
    );

    expect(plan).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("caps the tsdown heap when the cgroup mount exposes only a subtree", () => {
    // A container mount roots cgroupfs at the container's own cgroup, so /proc/self/cgroup
    // records stay host-absolute and only translate to a visible path via the mount root.
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/docker/abc123/openclaw-main-update.service\n"],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 /docker/abc123 /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n",
      ],
      ["/sys/fs/cgroup/openclaw-main-update.service/memory.max", `${5 * 1024 * 1024 * 1024}\n`],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=4352");
  });

  it("keeps a representable cgroup mount when a later view cannot represent it", () => {
    // Several mounts can expose one hierarchy; only the first covers this process here, so
    // retaining just the last-seen view would lose the budget entirely.
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/docker/abc123/openclaw-main-update.service\n"],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 /docker/abc123 /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n" +
          "31 25 0:26 /other/branch /mnt/peer-cgroup rw - cgroup2 cgroup2 rw\n",
      ],
      ["/sys/fs/cgroup/openclaw-main-update.service/memory.max", `${5 * 1024 * 1024 * 1024}\n`],
      ["/test/meminfo", "MemTotal: 7340032 kB\n"],
    ]);

    const nodeOptions = resolveTestNodeOptions({
      procMeminfoPath: "/test/meminfo",
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(nodeOptions).toBe("--max-old-space-size=4352");
  });

  it("fails closed on a mount that cannot represent this process's cgroup", () => {
    // An inherited namespace can leave a mount whose subtree holds someone else's cgroup.
    // The process's real limit is hidden, so neither that subtree nor host RAM is authoritative.
    const cgroupFiles = new Map([
      ["/proc/self/cgroup", "0::/other/branch/openclaw-main-update.service\n"],
      [
        "/proc/self/mountinfo",
        "30 25 0:26 /docker/abc123 /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n",
      ],
      ["/sys/fs/cgroup/memory.max", `${1024 * 1024 * 1024}\n`],
      ["/test/meminfo", "MemTotal: 7340032 kB\n"],
    ]);

    const result = resolveTsdownBuildPlan({
      env: {},
      procMeminfoPath: "/test/meminfo",
      fs: createMemoryFileSystem(cgroupFiles),
    });

    expect(result.maxOldSpaceMb).toBe(1);
    expect(result.heapShortfall?.fatal).toBe(true);
    expect(result.heapShortfall?.message).toContain(
      "process memory limit is not visible through this cgroup mount namespace",
    );
  });

  it("clamps explicit tsdown heap settings to the container memory limit", () => {
    const nodeOptions = resolveTestNodeOptions({
      env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=12288" },
      cgroupMemoryLimitBytes: 7 * 1024 * 1024 * 1024,
    });

    expect(nodeOptions).toBe("--trace-warnings --max-old-space-size=6400");
  });

  it("honors OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB over platform and memory defaults", () => {
    const nodeOptions = resolveTestNodeOptions({
      env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "3072" },
      cgroupMemoryLimitBytes: 7 * 1024 * 1024 * 1024,
    });

    expect(nodeOptions).toBe("--max-old-space-size=3072");
  });

  it("keeps memory detection when OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB is blank", () => {
    const nodeOptions = resolveTestNodeOptions({
      env: { OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "  " },
      cgroupMemoryLimitBytes: 7 * 1024 * 1024 * 1024,
    });

    expect(nodeOptions).toBe("--max-old-space-size=6400");
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
    const nodeOptions = resolveTestNodeOptions({
      fs: createMemoryFileSystem(
        new Map([
          ["/test/memory.max", "max\n"],
          ["/test/meminfo", "MemTotal: 7340032 kB\n"],
        ]),
      ),
      cgroupMemoryLimitPaths: ["/test/memory.max"],
      procMeminfoPath: "/test/meminfo",
    });

    expect(nodeOptions).toBe("--max-old-space-size=6400");
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

  it("limits cleanup to the explicitly selected declaration group", () => {
    expect(resolveTsdownCleanOutputRoots(["--config", "tsdown.ai.config.ts"])).toEqual([
      "packages/ai/dist",
    ]);
    expect(
      resolveTsdownCleanOutputRoots([
        "--config",
        "tsdown.config.ts",
        "--filter",
        "openclaw-packages",
      ]),
    ).toEqual(expect.arrayContaining(["packages/agent-core/dist", "packages/net-policy/dist"]));
    expect(
      resolveTsdownCleanOutputRoots(["--config=tsdown.config.ts", "--filter=openclaw-packages"]),
    ).not.toContain("packages/ai/dist");
    expect(resolveTsdownCleanOutputRoots(["-c=tsdown.config.ts", "-F=openclaw-unified"])).toEqual([
      "dist",
      "dist-runtime",
    ]);
    expect(
      resolveTsdownCleanOutputRoots([
        "-c=tsdown.config.ts",
        `-F=${TSDOWN_UNIFIED_DTS_CONFIG_GROUPS[0]}`,
      ]),
    ).toEqual(["dist", "dist-runtime"]);
    expect(
      resolveTsdownCleanOutputRoots([
        "--config",
        "configs/tsdown.config.ts",
        "--filter",
        "openclaw-packages",
      ]),
    ).toEqual(listTsdownOutputRoots());
    expect(resolveTsdownCleanOutputRoots(["--format", "esm"])).toEqual(listTsdownOutputRoots());
  });

  it("prunes stale hashed root chunk files but keeps stable aliases and nested assets", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-build-");
      const distDir = path.join(rootDir, "dist");
      const distRuntimeDir = path.join(rootDir, "dist-runtime");
      await fsPromises.mkdir(path.join(distDir, "control-ui"), { recursive: true });
      await fsPromises.mkdir(distRuntimeDir, { recursive: true });
      await fsPromises.writeFile(path.join(distDir, "delegate-BPjCe4gC.js"), "old delegate\n");
      await fsPromises.writeFile(
        path.join(distDir, "compact.runtime-2DiEmVcA.js"),
        "old runtime\n",
      );
      await fsPromises.writeFile(path.join(distDir, "compact.runtime.js"), "stable alias\n");
      await fsPromises.writeFile(path.join(distDir, "entry.js"), "entry\n");
      await fsPromises.writeFile(path.join(distDir, "control-ui", "index.html"), "asset\n");
      await fsPromises.writeFile(
        path.join(distRuntimeDir, "heartbeat-runner.runtime-fspOEj_1.js"),
        "old runtime\n",
      );
      await fsPromises.writeFile(
        path.join(distRuntimeDir, "heartbeat-runner.runtime.js"),
        "alias\n",
      );

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
  });

  it.each([
    { label: "default build", args: [], skipDts: "0", preserveMetadata: "0" },
    {
      label: "source launcher --no-clean",
      args: ["--no-clean"],
      skipDts: "1",
      preserveMetadata: "0",
    },
    { label: "build-all startup metadata", args: [], skipDts: "0", preserveMetadata: "1" },
    { label: "cached build-all", args: [], skipDts: "1", preserveMetadata: "1" },
  ])(
    "preserves separately owned outputs during $label cleanup",
    async ({ args, skipDts, preserveMetadata }) => {
      return fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-clean-");
        const sourceDependencies = await createSourcePluginDependenciesFixture(rootDir);
        sourceDependencies.assertResolution();
        const retainedFiles = [
          "dist/control-ui/index.html",
          "dist/control-ui/sw.js",
          "dist/control-ui/asset-manifest.json",
          "dist/control-ui/assets/index-AbCd1234.js",
          "dist/control-ui/assets/index-AbCd1234.js.map",
          "dist/control-ui/assets/index-AbCd1234.js.br",
          "dist/control-ui/assets/nested/styles-AbCd1234.css",
          "packages/plugin-sdk/dist/keep.js",
          "packages/agent-core/src/keep.ts",
          "tmp/keep.js",
        ];
        const declarationFiles = [
          "dist/plugin-sdk/core.d.ts",
          "dist/plugin-sdk/nested/types.d.cts",
          "dist-runtime/extensions/demo/index.d.ts",
          "packages/media-understanding-common/dist/index.d.mts",
          "packages/media-understanding-common/dist/nested/types.d.ts",
        ];
        const metadataFile = "dist/cli-startup-metadata.json";
        const staleFiles = [
          "dist/entry.js",
          "dist/stale-AbCd1234.js",
          "dist/stale-AbCd1234.js.map",
          "dist/plugin-sdk/core.js",
          "dist/nested/stale.js",
          "dist/nested/stale.js.map",
          "dist/control-ui-old/index.html",
          "dist/extensions/demo/src/index.js",
          "dist/extensions/demo/node_modules/staged/index.js",
          "dist/extensions/node_modules/openclaw/plugin-sdk/core.js",
          "dist-runtime/stale.js",
          "dist-runtime/stale.js.map",
          "dist-runtime/control-ui/index.html",
          "dist-runtime/extensions/demo/index.js",
          "dist-runtime/extensions/demo/node_modules/staged/index.js",
          "packages/agent-core/dist/stale.js",
          "packages/net-policy/dist/stale.js",
          "packages/media-understanding-common/dist/index.mjs",
          "packages/media-understanding-common/dist/chunks/old.js",
        ];
        for (const relativePath of [
          ...retainedFiles,
          ...declarationFiles,
          metadataFile,
          ...staleFiles,
        ]) {
          const filePath = path.join(rootDir, relativePath);
          await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
          await fsPromises.writeFile(filePath, `sentinel:${relativePath}\n`);
        }

        const scriptUrl = pathToFileURL(path.resolve("scripts/tsdown-build.mts")).href;
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            "--input-type=module",
            "-e",
            `import { prepareTsdownBuildExecution } from ${JSON.stringify(scriptUrl)};
       const plan = prepareTsdownBuildExecution(${JSON.stringify({ args, ...NO_MEMORY_LIMIT })});
       if (!plan) throw new Error("fixture build was not admitted");`,
          ],
          {
            cwd: rootDir,
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: skipDts,
              OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: preserveMetadata,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        sourceDependencies.assertResolution();
        for (const relativePath of staleFiles) {
          await expectPathMissing(path.join(rootDir, relativePath));
        }
        for (const relativePath of [
          "dist/extensions/demo/node_modules",
          "dist/extensions/node_modules",
          "dist-runtime/extensions/demo/node_modules",
          "packages/agent-core/dist",
          "packages/net-policy/dist",
        ]) {
          await expectPathMissing(path.join(rootDir, relativePath));
        }
        for (const [files, preserve] of [
          [declarationFiles, skipDts === "1"],
          [[metadataFile], preserveMetadata === "1"],
        ] as const) {
          for (const relativePath of files) {
            if (preserve) {
              retainedFiles.push(relativePath);
            } else {
              await expectPathMissing(path.join(rootDir, relativePath));
            }
          }
        }
        for (const relativePath of retainedFiles) {
          await expect(fsPromises.readFile(path.join(rootDir, relativePath), "utf8")).resolves.toBe(
            `sentinel:${relativePath}\n`,
          );
        }
      });
    },
  );

  it("cleans only selected tsdown output roots", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-selected-clean-");
      const aiFile = path.join(rootDir, "packages", "ai", "dist", "stale.js");
      const coreFile = path.join(rootDir, "dist", "keep.js");
      await fsPromises.mkdir(path.dirname(aiFile), { recursive: true });
      await fsPromises.mkdir(path.dirname(coreFile), { recursive: true });
      await fsPromises.writeFile(aiFile, "stale\n");
      await fsPromises.writeFile(coreFile, "keep\n");

      cleanTsdownOutputRoots({ cwd: rootDir, roots: ["packages/ai/dist"] });

      await expectPathMissing(aiFile);
      await expect(fsPromises.readFile(coreFile, "utf8")).resolves.toBe("keep\n");
    });
  });

  it.each(["OpenClaw.app", "candidates/OpenClaw.app"])(
    "keeps the packaged Mac app intact at %s while rebuilding its replacement runtime",
    async (appPath) => {
      return fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-app-pairing-");
        const appFile = path.join(rootDir, "dist", appPath, "Contents", "Resources", "worker.js");
        const staleFile = path.join(rootDir, "dist", "stale.js");
        await fsPromises.mkdir(path.dirname(appFile), { recursive: true });
        await fsPromises.writeFile(appFile, "previous signed worker\n");
        await fsPromises.writeFile(staleFile, "stale\n");

        cleanTsdownOutputRoots({ cwd: rootDir, roots: ["dist"] });

        await expect(fsPromises.readFile(appFile, "utf8")).resolves.toBe(
          "previous signed worker\n",
        );
        await expectPathMissing(staleFile);
      });
    },
  );

  it("cleans an absolute explicit output directory without rebasing it under cwd", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-absolute-clean-");
      const outputDir = path.join(rootDir, "custom-dist");
      const staleFile = path.join(outputDir, "stale.js");
      await fsPromises.mkdir(outputDir, { recursive: true });
      await fsPromises.writeFile(staleFile, "stale\n");

      cleanTsdownOutputRoots({ cwd: path.join(rootDir, "checkout"), roots: [outputDir] });

      await expectPathMissing(outputDir);
    });
  });

  it.each([".", "src"])(
    "refuses an output root containing checkout artifact ownership from %s",
    async (directory) => {
      return fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-owner-clean-");
        const cwd = path.join(rootDir, directory);
        const owner = path.join(rootDir, ".artifacts/dist-artifacts.lock/owner.json");
        await fsPromises.mkdir(path.dirname(owner), { recursive: true });
        await fsPromises.mkdir(cwd, { recursive: true });
        await fsPromises.mkdir(path.join(rootDir, ".git"));
        await fsPromises.writeFile(owner, "owned");
        expect(() =>
          cleanTsdownOutputRoots({ cwd, roots: [path.join(rootDir, ".artifacts")] }),
        ).toThrow("Cannot clean the checkout's dist artifact ownership location");
        expect(await fsPromises.readFile(owner, "utf8")).toBe("owned");
      });
    },
  );

  it("refuses to clean the working directory and leaves it intact", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-cwd-clean-");
      const keepFile = path.join(rootDir, "keep.js");
      await fsPromises.writeFile(keepFile, "keep\n");

      expect(() => cleanTsdownOutputRoots({ cwd: rootDir, roots: ["."] })).toThrow(
        "Cannot clean the current working directory",
      );

      await expect(fsPromises.readFile(keepFile, "utf8")).resolves.toBe("keep\n");
    });
  });

  it("refuses to clean a working-directory ancestor and leaves it intact", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-ancestor-clean-");
      const checkoutDir = path.join(rootDir, "checkout");
      const keepFile = path.join(rootDir, "keep.js");
      await fsPromises.mkdir(checkoutDir);
      await fsPromises.writeFile(keepFile, "keep\n");

      expect(() => cleanTsdownOutputRoots({ cwd: checkoutDir, roots: [".."] })).toThrow(
        "Cannot clean the current working directory or one of its ancestors",
      );

      await expect(fsPromises.readFile(keepFile, "utf8")).resolves.toBe("keep\n");
    });
  });

  it.each([
    ["drive", "D:\\"],
    ["UNC share", "\\\\server\\share\\"],
  ])("refuses to clean a Windows %s root", (_label, outputRoot) => {
    const rmSync = vi.spyOn(fs, "rmSync");
    try {
      expect(() =>
        cleanTsdownOutputRoots({
          cwd: "C:\\openclaw",
          pathImpl: path.win32,
          roots: [outputRoot],
        }),
      ).toThrow("Cannot clean a filesystem root");
      expect(rmSync).not.toHaveBeenCalled();
    } finally {
      rmSync.mockRestore();
    }
  });

  it("refuses a symlinked output root with preserved children and leaves the target unchanged", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-clean-symlink-");
      const targetDir = path.join(rootDir, "gateway-dist");
      const targetFile = path.join(targetDir, "chunk-abc123.js");
      const metadataFile = path.join(targetDir, "cli-startup-metadata.json");
      await fsPromises.mkdir(targetDir, { recursive: true });
      await fsPromises.writeFile(targetFile, "generated\n");
      await fsPromises.writeFile(metadataFile, '{"generatedBy":"test"}\n');
      const distLink = path.join(rootDir, "dist");
      await fsPromises.symlink(targetDir, distLink, "dir");

      expect(() =>
        cleanTsdownOutputRoots({
          cwd: rootDir,
          roots: ["dist"],
          env: { OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1" },
        }),
      ).toThrow(/symbolic link/u);

      expect(fs.readlinkSync(distLink)).toBe(targetDir);
      await expect(fsPromises.readFile(targetFile, "utf8")).resolves.toBe("generated\n");
      await expect(fsPromises.readFile(metadataFile, "utf8")).resolves.toBe(
        '{"generatedBy":"test"}\n',
      );
    });
  });

  it("rejects a symlink before traversing protected output children", () => {
    const readdirSync = vi.fn(fs.readdirSync);
    const fsImpl = {
      ...fs,
      lstatSync: () => ({ isSymbolicLink: () => true }),
      readdirSync,
    } as unknown as typeof fs;

    expect(() =>
      cleanTsdownOutputRoots({
        cwd: "/workspace",
        roots: ["dist"],
        env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
        fs: fsImpl,
      }),
    ).toThrow(/symbolic link/u);
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it("validates every clean root before mutating any output", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-clean-roots-");
      const firstRootFile = path.join(rootDir, "dist", "keep.js");
      const targetDir = path.join(rootDir, "gateway-runtime");
      await fsPromises.mkdir(path.dirname(firstRootFile), { recursive: true });
      await fsPromises.mkdir(targetDir);
      await fsPromises.writeFile(firstRootFile, "keep\n");
      await fsPromises.symlink(targetDir, path.join(rootDir, "dist-runtime"), "dir");

      expect(() =>
        cleanTsdownOutputRoots({
          cwd: rootDir,
          roots: ["dist", "dist-runtime"],
        }),
      ).toThrow(/symbolic link/u);

      await expect(fsPromises.readFile(firstRootFile, "utf8")).resolves.toBe("keep\n");
    });
  });

  it("refuses a symlinked output root even without protected children", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-clean-symlink-plain-");
      const targetDir = path.join(rootDir, "gateway-dist");
      const targetFile = path.join(targetDir, "stale.js");
      await fsPromises.mkdir(targetDir, { recursive: true });
      await fsPromises.writeFile(targetFile, "stale\n");
      const distLink = path.join(rootDir, "dist");
      await fsPromises.symlink(targetDir, distLink, "dir");

      expect(() => cleanTsdownOutputRoots({ cwd: rootDir, roots: ["dist"] })).toThrow(
        /symbolic link/u,
      );

      expect(fs.readlinkSync(distLink)).toBe(targetDir);
      await expect(fsPromises.readFile(targetFile, "utf8")).resolves.toBe("stale\n");
    });
  });

  it("refuses an output root behind an intermediate symlink", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-clean-parent-symlink-");
      const checkoutDir = path.join(rootDir, "checkout");
      const targetDir = path.join(rootDir, "external", "dist");
      const targetFile = path.join(targetDir, "keep.js");
      await fsPromises.mkdir(checkoutDir);
      await fsPromises.mkdir(targetDir, { recursive: true });
      await fsPromises.writeFile(targetFile, "keep\n");
      await fsPromises.symlink(path.dirname(targetDir), path.join(checkoutDir, "linked"), "dir");

      expect(() =>
        cleanTsdownOutputRoots({ cwd: checkoutDir, roots: [path.join("linked", "dist")] }),
      ).toThrow(/symbolic link/u);

      await expect(fsPromises.readFile(targetFile, "utf8")).resolves.toBe("keep\n");
    });
  });

  it("refuses to prune stale root chunks through a symlinked output root", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-prune-symlink-");
      const targetDir = path.join(rootDir, "gateway-dist");
      const hashedFile = path.join(targetDir, "delegate-BPjCe4gC.js");
      await fsPromises.mkdir(targetDir, { recursive: true });
      await fsPromises.writeFile(hashedFile, "old delegate\n");
      const distLink = path.join(rootDir, "dist");
      await fsPromises.symlink(targetDir, distLink, "dir");

      expect(() => pruneStaleRootChunkFiles({ cwd: rootDir })).toThrow(/symbolic link/u);

      expect(fs.readlinkSync(distLink)).toBe(targetDir);
      await expect(fsPromises.readFile(hashedFile, "utf8")).resolves.toBe("old delegate\n");
    });
  });

  it("validates every chunk root before pruning any output", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-prune-roots-");
      const firstRootFile = path.join(rootDir, "dist", "delegate-OldHash.js");
      const targetDir = path.join(rootDir, "gateway-runtime");
      await fsPromises.mkdir(path.dirname(firstRootFile), { recursive: true });
      await fsPromises.mkdir(targetDir);
      await fsPromises.writeFile(firstRootFile, "keep\n");
      await fsPromises.symlink(targetDir, path.join(rootDir, "dist-runtime"), "dir");

      expect(() => pruneStaleRootChunkFiles({ cwd: rootDir })).toThrow(/symbolic link/u);

      await expect(fsPromises.readFile(firstRootFile, "utf8")).resolves.toBe("keep\n");
    });
  });

  it("refuses to prune runtime overlay symlinks through a symlinked output root", async () => {
    return fixture.run(async () => {
      const rootDir = createTempDir("openclaw-tsdown-runtime-symlink-");
      const targetDir = path.join(rootDir, "gateway-dist");
      const pluginNodeModules = path.join(targetDir, "extensions", "telegram", "node_modules");
      await fsPromises.mkdir(pluginNodeModules, { recursive: true });
      const markerFile = path.join(pluginNodeModules, "keep.js");
      await fsPromises.writeFile(markerFile, "keep\n");
      const distLink = path.join(rootDir, "dist");
      await fsPromises.symlink(targetDir, distLink, "dir");

      expect(() => pruneStaleRuntimeSymlinks({ cwd: rootDir })).toThrow(/symbolic link/u);

      expect(fs.readlinkSync(distLink)).toBe(targetDir);
      await expect(fsPromises.readFile(markerFile, "utf8")).resolves.toBe("keep\n");
    });
  });

  it("prunes untracked generated declaration files that shadow source entries", async () => {
    return fixture.run(async () => {
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

  function startTimeoutFixture(
    parentScript: string,
    output: ReturnType<typeof createWriteSink>,
    signal: AbortSignal,
  ) {
    const schedule = globalThis.setTimeout;
    const cancel = globalThis.clearTimeout;
    let now = Date.now();
    const clock = vi.spyOn(Date, "now");
    let abortFailure: Error | undefined;
    const pending = new Map<ReturnType<typeof setTimeout>, { at: number; fire: () => void }>();
    // Only the watchdog and escalation use 250ms. Group polling stays real, but
    // its Date.now deadline shares this logical clock with both callbacks.
    const timers = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, ms, ...args) => {
        if (ms !== 250) {
          return schedule(callback, ms, ...args);
        }
        const handle = schedule(() => {}, ms);
        pending.set(handle, { at: now + ms, fire: () => callback(...args) });
        return handle;
      });
    const clears = vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
      if (typeof handle === "object" && handle) {
        pending.delete(handle);
      }
      cancel(handle);
    });
    const completion = runTsdownBuildInvocation(
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
    const supervisor = {
      completion,
      advance(ms: number) {
        const target = now + ms;
        while (true) {
          const next = [...pending].toSorted((left, right) => left[1].at - right[1].at)[0];
          if (!next || next[1].at > target) {
            break;
          }
          now = next[1].at;
          clock.mockReturnValue(now);
          pending.delete(next[0]);
          cancel(next[0]);
          next[1].fire();
        }
        now = target;
        clock.mockReturnValue(now);
      },
      resume() {
        const started = performance.now();
        clock.mockImplementation(() => now + performance.now() - started);
      },
      restore() {
        signal.removeEventListener("abort", abort);
        for (const handle of pending.keys()) {
          cancel(handle);
        }
        clears.mockRestore();
        timers.mockRestore();
        clock.mockRestore();
        if (abortFailure) {
          throw abortFailure;
        }
      },
    };
    const abort = () => {
      try {
        try {
          supervisor.advance(500);
        } finally {
          supervisor.resume();
        }
      } catch (error) {
        // Event listeners cannot reject the driver promise. Report the failure
        // from restoration after the caller has awaited the owned completion.
        abortFailure = new Error("Controlled supervisor cancellation failed", { cause: error });
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    return supervisor;
  }

  it("streams child output while preserving diagnostics for post-run checks", async () => {
    return fixture.run(async () => {
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
  });

  it.for(["native declarations", "runtime JavaScript"])(
    "preserves successful %s when source syntax is invalid",
    async (mode, { signal }) => {
      return fixture.run(async () => {
        const native = mode === "native declarations";
        const rootDir = fs.realpathSync(createTempDir("openclaw-tsdown-syntax-"));
        const sourcePath = path.join(rootDir, "index.ts");
        const outputPath = path.join(rootDir, "dist", native ? "index.d.ts" : "index.js");
        fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}\n');
        fs.writeFileSync(
          path.join(rootDir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "Bundler",
              declaration: true,
              emitDeclarationOnly: true,
              noCheck: true,
              noEmitOnError: false,
              rootDir,
            },
            files: [sourcePath],
          }),
        );
        const buildOptions = {
          clean: false,
          config: false,
          cwd: rootDir,
          entry: [sourcePath],
          fixedExtension: false,
          format: "esm",
          logLevel: "error",
          outDir: path.join(rootDir, "dist"),
          platform: "node",
          report: false,
          tsconfig: path.join(rootDir, "tsconfig.json"),
        };
        const dtsOptions = native
          ? '{ generator: "tsgo", emitDtsOnly: true, tsgo: { path: getExePath() } }'
          : "false";
        const script = [
          'import { build } from "tsdown";',
          ...(native
            ? [
                'const nativePackage = import.meta.resolve("@typescript/native-preview/package.json");',
                'const { default: getExePath } = await import(new URL("lib/getExePath.js", nativePackage).href);',
              ]
            : []),
          `await build({ ...${JSON.stringify(buildOptions)}, dts: ${dtsOptions} });`,
        ].join("\n");
        const output = createWriteSink();
        // Keep compiler scratch output inside the fixture even when compilation rejects.
        const env = { ...process.env, TMPDIR: rootDir, TEMP: rootDir, TMP: rootDir };
        const invocation = {
          command: process.execPath,
          args: ["--input-type=module", "-e", script],
          options: { stdio: ["ignore", "pipe", "pipe"], shell: false, env },
        };
        const runOptions = { stdout: output.sink, stderr: output.sink };

        fs.writeFileSync(sourcePath, 'export const broken = "healthy";\n');
        const healthy = await runTsdownBuildInvocation(invocation, runOptions);
        expect(healthy.status, healthy.captured).toBe(0);
        const previous = fs.readFileSync(outputPath, "utf8");
        expect(previous).toContain('"healthy"');

        signal.throwIfAborted();
        fs.writeFileSync(sourcePath, "export const broken = ;\n");
        const failed = await runTsdownBuildInvocation(invocation, runOptions);
        expect(failed).toMatchObject({ error: null, signal: null, timedOut: false });
        expect(failed.status, failed.captured).toBeGreaterThan(0);
        expect(fs.readFileSync(outputPath, "utf8")).toBe(previous);
        expect(failed.captured).toContain(native ? "TS1109" : "PARSE_ERROR");
      });
    },
  );

  it("rejects malformed OPENCLAW_TSDOWN_TIMEOUT_MS values", async () => {
    return fixture.run(async () => {
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
  });

  it("rejects malformed OPENCLAW_TSDOWN_HEARTBEAT_MS values", async () => {
    return fixture.run(async () => {
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
  });

  it("terminates the child when OPENCLAW_TSDOWN_TIMEOUT_MS elapses", async () => {
    return fixture.run(async () => {
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

  it.skipIf(process.platform === "win32")(
    "kills timed-out tsdown process groups when the wrapper exits first",
    async ({ signal }) => {
      return fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-timeout-");
        const childPidPath = path.join(rootDir, "child.pid");
        const parentPidPath = path.join(rootDir, "parent.pid");
        const termPath = path.join(rootDir, "child.term");
        // Allocate the marker before readiness; filesystem setup must not consume termination grace.
        const childScript = [
          "const fs = require('node:fs');",
          `const termFd = fs.openSync(${JSON.stringify(termPath)}, 'wx');`,
          "process.on('SIGTERM', () => fs.writeSync(termFd, 'SIGTERM', 0));",
          `fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.ppid));`,
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "process.on('SIGTERM', () => process.exit(0));",
          `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const output = createWriteSink();
        const supervisor = startTimeoutFixture(parentScript, output, signal);
        let childPid: number | undefined;

        try {
          // The descendant publishes its PID only after installing its SIGTERM handler.
          childPid = await waitForPidFile(childPidPath, 2_000);
          expect(isProcessAlive(childPid)).toBe(true);
          supervisor.advance(250);
          await vi.waitUntil(() => fs.readFileSync(termPath, "utf8") === "SIGTERM", {
            timeout: 2_000,
            interval: 5,
          });
          const parentPid = Number(fs.readFileSync(parentPidPath, "utf8"));
          await vi.waitUntil(() => !isProcessAlive(parentPid), { timeout: 2_000, interval: 5 });
          supervisor.advance(249);
          expect(isProcessAlive(childPid)).toBe(true);
          expect(output.chunks.join("")).not.toContain("forcing SIGKILL");
          supervisor.advance(1);
          supervisor.resume();
          const result = await supervisor.completion;

          expect(result).toMatchObject({ timedOut: true, status: 0, signal: null, error: null });
          expect(fs.readFileSync(termPath, "utf8")).toBe("SIGTERM");
          expect(output.chunks.join("")).toContain("forcing SIGKILL");
          await waitForDead(childPid, 2_000);
        } finally {
          await fixture.verifyCleanup(async () => {
            try {
              try {
                supervisor.advance(500);
              } finally {
                supervisor.resume();
              }
            } finally {
              try {
                await supervisor.completion;
                if (childPid !== undefined && isProcessAlive(childPid)) {
                  process.kill(childPid, "SIGKILL");
                  await waitForDead(childPid, 2_000);
                }
              } finally {
                supervisor.restore();
              }
            }
          });
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves timeout grace when descendant processes exit cleanly",
    async ({ signal }) => {
      return fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-timeout-clean-");
        const cleanupPath = path.join(rootDir, "child.cleanup");
        const termPath = path.join(rootDir, "child.term");
        const releasePath = path.join(rootDir, "child.release");
        const childPidPath = path.join(rootDir, "child.pid");
        const parentPidPath = path.join(rootDir, "parent.pid");
        // Allocate markers before readiness; their contents record signal and released cleanup.
        const childScript = [
          "const fs = require('node:fs');",
          `const termFd = fs.openSync(${JSON.stringify(termPath)}, 'wx');`,
          `const cleanupFd = fs.openSync(${JSON.stringify(cleanupPath)}, 'wx');`,
          "process.on('SIGTERM', () => {",
          "  fs.writeSync(termFd, 'SIGTERM', 0);",
          "  setInterval(() => {",
          `    if (!fs.existsSync(${JSON.stringify(releasePath)})) return;`,
          "    fs.writeSync(cleanupFd, 'clean', 0);",
          "    process.exit(0);",
          "  }, 5);",
          "});",
          `fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.ppid));`,
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "process.on('SIGTERM', () => process.exit(0));",
          `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const output = createWriteSink();
        const supervisor = startTimeoutFixture(parentScript, output, signal);
        let childPid: number | undefined;

        try {
          // The descendant publishes its PID only after installing its SIGTERM handler.
          childPid = await waitForPidFile(childPidPath, 2_000);
          supervisor.advance(250);
          await vi.waitUntil(() => fs.readFileSync(termPath, "utf8") === "SIGTERM", {
            timeout: 2_000,
            interval: 5,
          });
          const parentPid = Number(fs.readFileSync(parentPidPath, "utf8"));
          await vi.waitUntil(() => !isProcessAlive(parentPid), { timeout: 2_000, interval: 5 });
          supervisor.advance(249);
          expect(isProcessAlive(childPid)).toBe(true);
          expect(fs.readFileSync(cleanupPath, "utf8")).toBe("");
          expect(output.chunks.join("")).not.toContain("forcing SIGKILL");
          fs.writeFileSync(releasePath, "release");
          const result = await supervisor.completion;

          expect(result).toMatchObject({ timedOut: true, status: 0, signal: null, error: null });
          expect(fs.readFileSync(cleanupPath, "utf8")).toBe("clean");
          expect(output.chunks.join("")).not.toContain("forcing SIGKILL");
          // Even a late escalation callback must be inert after the real join.
          supervisor.advance(1);
          expect(output.chunks.join("")).not.toContain("forcing SIGKILL");
          supervisor.resume();
          await waitForDead(childPid, 2_000);
        } finally {
          await fixture.verifyCleanup(async () => {
            try {
              try {
                supervisor.advance(500);
              } finally {
                supervisor.resume();
              }
            } finally {
              try {
                await supervisor.completion;
                if (childPid !== undefined && isProcessAlive(childPid)) {
                  process.kill(childPid, "SIGKILL");
                  await waitForDead(childPid, 2_000);
                }
              } finally {
                supervisor.restore();
              }
            }
          });
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "joins a canceled controlled-grace driver with a held child",
    async ({ signal }) => {
      return fixture.run(async () => {
        const root = createTempDir("tsdown-canceled-driver-");
        const ready = path.join(root, "ready");
        const term = path.join(root, "term");
        const controller = new AbortController();
        const output = createWriteSink();
        const supervisor = startTimeoutFixture(
          `
        const fs = require("node:fs");
        process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(term)}, "term"));
        fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        setInterval(() => {}, 1000);
      `,
          output,
          AbortSignal.any([signal, controller.signal]),
        );
        let pid = 0;
        try {
          pid = await waitForPidFile(ready, 2_000);
          supervisor.advance(250);
          await vi.waitUntil(() => fs.existsSync(term), { timeout: 2_000, interval: 5 });
          supervisor.advance(249);
          expect(isProcessAlive(pid)).toBe(true);
          expect(output.chunks.join("")).not.toContain("forcing SIGKILL");
          controller.abort(new Error("driver canceled"));
          expect(output.chunks.join("")).toContain("forcing SIGKILL");
          await expect(supervisor.completion).resolves.toMatchObject({
            timedOut: true,
            status: null,
            signal: "SIGKILL",
            error: null,
          });
          await waitForDead(pid, 2_000);
        } finally {
          await fixture.verifyCleanup(async () => {
            try {
              try {
                supervisor.advance(500);
              } finally {
                supervisor.resume();
              }
            } finally {
              try {
                await supervisor.completion;
                if (pid && isProcessAlive(pid)) {
                  process.kill(pid, "SIGKILL");
                  await waitForDead(pid, 2_000);
                }
              } finally {
                supervisor.restore();
              }
            }
          });
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans process-group descendants before forwarding parent SIGTERM",
    async () => {
      return fixture.run(async () => {
        const rootDir = createTempDir("openclaw-tsdown-parent-signal-");
        const childPidPath = path.join(rootDir, "child.pid");
        const readyPath = path.join(rootDir, "child.ready");
        const scriptUrl = pathToFileURL(path.resolve("scripts/tsdown-build.mts")).href;
        let childPid = 0;
        let runner: ReturnType<typeof spawn> | undefined;
        let runnerClosed: Promise<unknown> | undefined;

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
            "const result = await runTsdownBuildInvocation(",
            `  { command: process.execPath, args: ['-e', ${JSON.stringify(parentScript)}], options: { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: process.env } },`,
            "  { env: { ...process.env, OPENCLAW_TSDOWN_HEARTBEAT_MS: '0' } },",
            "); process.exitCode = result.status ?? 1;",
          ].join("\n");

          runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
            cwd: process.cwd(),
            stdio: ["ignore", "ignore", "pipe"],
          });

          runnerClosed = fixture.track(once(runner, "close"));
          await waitForFile(readyPath, 2_000);
          childPid = await waitForPidFile(childPidPath, 2_000);
          expect(isProcessAlive(childPid)).toBe(true);

          runner.kill("SIGTERM");

          await expect(waitForChildClose(runner)).resolves.toEqual({
            code: 143,
            signal: null,
          });
          await waitForDead(childPid, 2_000);
        } finally {
          await fixture.verifyCleanup(async () => {
            if (runner?.pid && isProcessAlive(runner.pid)) {
              runner.kill("SIGTERM");
            }
            await runnerClosed;
            if (childPid && isProcessAlive(childPid)) {
              process.kill(childPid, "SIGKILL");
              await waitForDead(childPid, 2_000);
            }
          });
        }
      });
    },
  );
});
