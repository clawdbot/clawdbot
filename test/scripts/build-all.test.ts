// Build All tests cover build all script behavior.
import { spawnSync, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  BUILD_ALL_PROFILES,
  BUILD_ALL_PROFILE_STEP_ENV,
  BUILD_ALL_STEPS,
  formatBuildAllDuration,
  formatBuildAllTimingSummary,
  parseBuildAllArgs,
  resolveBuildAllEnvironment,
  resolveBuildAllStep,
  resolveBuildAllStepOnCacheHit,
  resolveBuildAllSteps,
  resolveBuildAllTsdownPlan,
  runBuildAllSteps,
} from "../../scripts/build-all.mts";
import {
  resolveBuildStepCacheState,
  writeBuildStepCacheStamp,
  resolveBuildStepCacheStampState,
  restoreBuildStepCacheOutputs,
  finalizeBuildStepCache,
} from "../../scripts/lib/build-artifact-cache.mts";
import { listBundledPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { createManagedCommandInvocation } from "../../scripts/lib/managed-child-process.mts";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mts";
import { runNodeMain } from "../../scripts/run-node.mts";

function getBuildAllStep(label: string) {
  const step = BUILD_ALL_STEPS.find((entry) => entry.label === label);
  if (!step) {
    throw new Error(`Missing build-all step ${label}`);
  }
  return step;
}

function buildMemoryLimit(cgroupGiB: number) {
  // A cgroup-only fixture still reads Linux MemAvailable. Pin the host facts so
  // concurrent CI work cannot change the admission this scenario exercises.
  return {
    platform: "linux",
    availableMemoryBytes: 16 * 1024 ** 3,
    procMemTotalBytes: 16 * 1024 ** 3,
    cgroupMemoryLimitBytes: cgroupGiB * 1024 ** 3,
  };
}

function withBuildCacheFixture(
  run: (fixture: {
    rootDir: string;
    inputPath: string;
    outputPath: string;
    step: {
      label: string;
      cache: {
        inputs: Array<
          | string
          | {
              path: string;
              excludeDirectories?: string[];
              extensions?: string[];
              recursive?: boolean;
            }
        >;
        outputs: Array<
          | string
          | {
              path: string;
              excludeDirectories?: string[];
              extensions?: string[];
              recursive?: boolean;
            }
        >;
        requiredOutputs?: string[] | ((env: NodeJS.ProcessEnv) => string[]);
        restore?: "always";
        runOnHit?: {
          env?: NodeJS.ProcessEnv;
          finalize?: "refresh";
        };
      };
    };
  }) => void,
) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-cache-"));
  try {
    const inputPath = path.join(rootDir, "src/input.ts");
    const outputPath = path.join(rootDir, "dist/output.js");
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(inputPath, "input");
    fs.writeFileSync(outputPath, "output");
    run({
      rootDir,
      inputPath,
      outputPath,
      step: {
        label: "cached",
        cache: {
          inputs: ["src"],
          outputs: ["dist"],
        },
      },
    });
  } finally {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
}

describe("resolveBuildAllStep", () => {
  it("pins one generated timestamp across every child build", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const buildEnv = resolveBuildAllEnvironment(
      { FOO: "bar" },
      () => new Date("2026-07-10T12:34:56.789Z"),
      () => commit,
    );
    const uiInvocation = resolveBuildAllStep(getBuildAllStep("ui:build"), {
      env: buildEnv,
    });
    const buildInfoInvocation = resolveBuildAllStep(getBuildAllStep("write-build-info"), {
      env: buildEnv,
    });

    expect(uiInvocation.options.env).toMatchObject({
      FOO: "bar",
      GIT_COMMIT: commit,
      OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56.789Z",
    });
    expect(buildInfoInvocation.options.env.OPENCLAW_BUILD_TIMESTAMP).toBe(
      uiInvocation.options.env.OPENCLAW_BUILD_TIMESTAMP,
    );
  });

  it("pins the first explicit full commit alias and rejects malformed values", () => {
    const gitSha = "A".repeat(40);
    expect(
      resolveBuildAllEnvironment(
        { GIT_SHA: gitSha, GITHUB_SHA: "b".repeat(40) },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => "c".repeat(40),
      ).GIT_COMMIT,
    ).toBe(gitSha.toLowerCase());
    expect(() =>
      resolveBuildAllEnvironment({ GIT_COMMIT: "deadbeef" }, undefined, () => null),
    ).toThrow("full 40-character hexadecimal SHA");
  });

  it("uses checked-out Git instead of unverified GitHub workflow context", () => {
    const checkedOutCommit = "b".repeat(40);
    const ambientCommit = "a".repeat(40);

    expect(
      resolveBuildAllEnvironment(
        { GITHUB_SHA: ambientCommit },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => checkedOutCommit,
      ).GIT_COMMIT,
    ).toBe(checkedOutCommit);
    expect(
      resolveBuildAllEnvironment(
        { GITHUB_SHA: ambientCommit },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => null,
      ).GIT_COMMIT,
    ).toBe(ambientCommit);
    expect(() =>
      resolveBuildAllEnvironment(
        { GITHUB_SHA: "bad" },
        () => new Date("2026-07-10T12:34:56.000Z"),
        () => null,
      ),
    ).toThrow("full 40-character hexadecimal SHA");
  });

  it("preserves an explicit build timestamp after trimming outer whitespace", () => {
    expect(
      resolveBuildAllEnvironment({
        OPENCLAW_BUILD_TIMESTAMP: " 2026-07-10T01:02:03.000Z ",
      }).OPENCLAW_BUILD_TIMESTAMP,
    ).toBe("2026-07-10T01:02:03.000Z");
  });

  it("routes pnpm steps through the npm_execpath pnpm runner on Windows", () => {
    const step = getBuildAllStep("plugins:assets:build");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm.cjs");
    fs.writeFileSync(npmExecPath, "console.log('pnpm');\n");

    try {
      const result = resolveBuildAllStep(step, {
        platform: "win32",
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath,
        env: {},
      });

      expect(result).toEqual({
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [npmExecPath, "plugins:assets:build"],
        options: {
          stdio: "inherit",
          env: {},
          shell: false,
          windowsVerbatimArguments: undefined,
        },
      });
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps node steps on the current node binary", () => {
    const step = getBuildAllStep("runtime-postbuild");

    const result = resolveBuildAllStep(step, {
      nodeExecPath: "/custom/node",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({
      command: "/custom/node",
      args: ["scripts/runtime-postbuild.mjs"],
      options: {
        stdio: "inherit",
        env: { FOO: "bar" },
        shell: false,
      },
    });
  });

  it("passes encoded import URLs literally to managed Node on Windows", () => {
    const importUrl = "file:///C:/Users/RUNNER%7E1/Project/scripts/tsx.mjs";
    const result = resolveBuildAllStep(
      { label: "tsdown-unified", args: ["--import", importUrl, "scripts/tsdown-build.mts"] },
      { platform: "win32", nodeExecPath: "C:\\Program Files\\nodejs\\node.exe", env: {} },
    );

    expect(
      createManagedCommandInvocation({
        bin: result.command,
        args: result.args,
        ...result.options,
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["--import", importUrl, "scripts/tsdown-build.mts"],
      shell: false,
      windowsVerbatimArguments: undefined,
    });
  });

  it.each([
    {
      label: "write-plugin-sdk-entry-dts",
      scriptPath: "scripts/write-plugin-sdk-entry-dts.ts",
      expectedEnv: { FOO: "bar", OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
    },
    {
      label: "write-unified-entry-dts",
      scriptPath: "scripts/write-unified-entry-dts.ts",
      expectedEnv: { FOO: "bar", OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
    },
    {
      label: "write-build-info",
      scriptPath: "scripts/write-build-info.ts",
      expectedEnv: { FOO: "bar" },
    },
    {
      label: "write-cli-startup-metadata",
      scriptPath: "scripts/write-cli-startup-metadata.ts",
      expectedEnv: { FOO: "bar" },
    },
  ])("runs the $label TypeScript step through tsx", ({ label, scriptPath, expectedEnv }) => {
    const step = getBuildAllStep(label);

    const result = resolveBuildAllStep(step, {
      nodeExecPath: "/custom/node",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({
      command: "/custom/node",
      args: ["--import", "tsx", scriptPath],
      options: {
        stdio: "inherit",
        env: expectedEnv,
        shell: false,
      },
    });
  });

  it.each([
    {
      label: "plugins:assets:build",
      args: ["--import", "tsx", "scripts/bundled-plugin-assets.mts", "--phase", "build"],
    },
    {
      label: "plugins:assets:copy",
      args: ["--import", "tsx", "scripts/bundled-plugin-assets.mts", "--phase", "copy"],
    },
    { label: "ui:build", args: ["scripts/ui.js", "build"] },
  ])("runs the $label native fallback through managed Node on Windows", ({ label, args }) => {
    const result = resolveBuildAllStep(getBuildAllStep(label), {
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
    });
    expect(
      createManagedCommandInvocation({
        bin: result.command,
        args: result.args,
        ...result.options,
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args,
      shell: false,
      windowsVerbatimArguments: undefined,
    });
    expect(result.options).toEqual({
      stdio: "inherit",
      env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
      shell: false,
    });
  });

  it("restores startup metadata as a validator seed and refreshes it after validation", () => {
    const step = getBuildAllStep("write-cli-startup-metadata");

    expect(step.cache).toMatchObject({
      inputs: [
        "scripts/write-cli-startup-metadata.ts",
        "scripts/lib/cli-startup-root-help-bundle.ts",
      ],
      outputs: ["dist/cli-startup-metadata.json"],
      restore: "always",
      runOnHit: { finalize: "refresh" },
    });
    expect(resolveBuildAllStepOnCacheHit(step)).not.toBeNull();
  });
});

describe("resolveBuildAllSteps", () => {
  it("parses build-all CLI args before any build work", () => {
    expect(parseBuildAllArgs([])).toEqual({ help: false, profile: "full" });
    expect(parseBuildAllArgs(["cliStartup"])).toEqual({ help: false, profile: "cliStartup" });
    expect(parseBuildAllArgs(["cliStartup", "--help"])).toEqual({
      help: true,
      profile: "cliStartup",
    });
    expect(() => parseBuildAllArgs(["cliStartup", "--bogus"])).toThrow("unknown argument: --bogus");
    expect(() => parseBuildAllArgs(["wat"])).toThrow("Unknown build profile: wat");
  });

  it("prints CLI help without starting build steps", () => {
    for (const args of [["--help"], ["cliStartup", "--help"]]) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/build-all.mts", ...args],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage: node --import tsx scripts/build-all.mts [profile]");
      expect(result.stdout).toContain("cliStartup");
      expect(result.stdout).not.toContain("[build-all]");
    }
  });

  it("rejects unknown CLI args without starting build steps", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/build-all.mts", "cliStartup", "--bogus"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown argument: --bogus");
    expect(result.stderr).toContain("Usage: node --import tsx scripts/build-all.mts [profile]");
    expect(result.stderr).toContain("Profiles:");
    expect(result.stderr).not.toContain("[build-all]");
    expect(result.stderr).not.toContain("at ");
  });

  it("uses declaration-cache groups only for the full build", () => {
    expect(resolveBuildAllSteps("full").map((step) => step.label)).toEqual([
      "plugins:assets:build",
      "tsdown-ai",
      "tsdown-packages",
      "tsdown-unified",
      "write-unified-entry-dts",
      "external-plugins:local-dist",
      "check-cli-bootstrap-imports",
      "plugins:assets:copy",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
      "write-plugin-sdk-entry-dts",
      "check-plugin-sdk-exports",
      "ui:build",
      "write-build-info",
      "write-cli-startup-metadata",
    ]);
    expect(BUILD_ALL_PROFILES.ciArtifacts).toContain("tsdown");
    expect(BUILD_ALL_PROFILES.ciArtifacts).not.toContain("tsdown-unified");
  });

  it("cleans dist before the full package build steps", () => {
    const packageSteps = resolveBuildAllSteps("package");
    expect(packageSteps.map((step) => step.label)).toEqual([
      "clean:dist",
      ...resolveBuildAllSteps("full").map((step) => step.label),
    ]);
  });

  it.each(["full", "package", "ciArtifacts"])(
    "refuses %s before any build step or cache work when memory is insufficient",
    async (profile) => {
      const runStep = vi.fn(() => ({ status: 0 }));
      const resolveCacheState = vi.fn(() => ({
        cacheable: false,
        fresh: false,
        reason: "no-cache",
      }));
      const restoreCache = vi.fn(() => true);
      const finalizeCache = vi.fn(() => true);
      const logger = { error: vi.fn(), warn: vi.fn() };

      const result = await runBuildAllSteps(profile, {
        env: {},
        logger,
        memoryLimit: buildMemoryLimit(4),
        resolveCacheState,
        restoreCache,
        finalizeCache,
        runStep,
      });

      expect(result).toEqual({ exitCode: 1, timings: [] });
      expect(runStep).not.toHaveBeenCalled();
      expect(resolveCacheState).not.toHaveBeenCalled();
      expect(restoreCache).not.toHaveBeenCalled();
      expect(finalizeCache).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Stopping before any build output is removed"),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each(["full", "package"])(
    "admits %s once and freezes its heap for every child",
    async (profile) => {
      const tsdownSteps = resolveBuildAllSteps(profile).filter(
        (step) => step.label.startsWith("tsdown-") || step.label === "write-unified-entry-dts",
      );
      const tsdownInvocations: ReturnType<typeof resolveBuildAllStep>[] = [];
      const executionOrder: string[] = [];
      const restoreCache = vi.fn(() => true);
      const result = await runBuildAllSteps(profile, {
        cacheEnabled: true,
        env: {},
        finalizeCache: vi.fn(() => true),
        logger: { error: vi.fn(), warn: vi.fn() },
        memoryLimit: buildMemoryLimit(5),
        now: () => 0,
        resolveCacheState(step) {
          executionOrder.push(`cache:${step.label}`);
          return step.label === "tsdown-packages"
            ? {
                cacheable: true,
                fresh: true,
                restorable: true,
                reason: "fresh-cache",
                signature: "test-signature",
                outputRoot: "/test/cache",
                stampPath: "/test/cache-stamp.json",
                inputFiles: 1,
                outputFiles: 1,
                relativeOutputFiles: ["dist/test.js"],
                stampedOutputs: ["dist/test.js"],
                record: undefined,
              }
            : { cacheable: false, fresh: false, reason: "no-cache" };
        },
        restoreCache,
        runStep(invocation) {
          executionOrder.push(
            `run:${expectDefined(tsdownSteps[tsdownInvocations.length], "next tsdown step").label}`,
          );
          tsdownInvocations.push(invocation);
          return { status: 0 };
        },
        steps: tsdownSteps,
      });

      expect(result.exitCode).toBe(0);
      expect(tsdownInvocations).toHaveLength(4);
      for (const invocation of tsdownInvocations) {
        expect(invocation.options.env.OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB).toBe("4352");
        expect(invocation.options.env.NODE_OPTIONS).toBe("--max-old-space-size=4352");
      }
      expect(restoreCache).toHaveBeenCalledOnce();
      expect(executionOrder).toEqual([
        "cache:tsdown-ai",
        "run:tsdown-ai",
        "cache:tsdown-packages",
        "run:tsdown-packages",
        "cache:tsdown-unified",
        "run:tsdown-unified",
        "cache:write-unified-entry-dts",
        "run:write-unified-entry-dts",
      ]);

      const cacheDisabledRunner = vi.fn(() => ({ status: 0 }));
      await runBuildAllSteps("ciArtifacts", {
        env: { OPENCLAW_BUILD_CACHE: "0" },
        memoryLimit: buildMemoryLimit(5),
        finalizeCache: vi.fn(() => true),
        logger: { error: vi.fn(), warn: vi.fn() },
        now: () => 0,
        resolveCacheState: () => ({
          cacheable: true,
          fresh: true,
          reason: "fresh",
          restorable: false,
          signature: "test-signature",
          outputRoot: "/test/cache",
          stampPath: "/test/cache-stamp.json",
          inputFiles: 1,
          outputFiles: 1,
          relativeOutputFiles: ["dist/test.js"],
          stampedOutputs: ["dist/test.js"],
          record: undefined,
        }),
        runStep: cacheDisabledRunner,
        steps: [expectDefined(tsdownSteps[0], "first tsdown step")],
      });
      expect(cacheDisabledRunner).toHaveBeenCalledOnce();
    },
  );

  it.each(["gatewayWatch", "qaRuntime", "sourcePerformance", "cliStartup"])(
    "skips heap admission for partial profile %s",
    async (profile) => {
      const partialEnv = { MARKER: "unchanged", NODE_OPTIONS: "--max-old-space-size=256" };
      expect(resolveBuildAllTsdownPlan(profile, partialEnv, buildMemoryLimit(4))).toEqual({
        env: partialEnv,
        heapShortfall: null,
      });
      const runStep = vi.fn<
        (invocation: ReturnType<typeof resolveBuildAllStep>) => { status: number }
      >(() => ({ status: 0 }));
      const result = await runBuildAllSteps(profile, {
        env: partialEnv,
        logger: { error: vi.fn(), warn: vi.fn() },
        memoryLimit: buildMemoryLimit(4),
        resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
        runStep,
      });
      expect(result.exitCode).toBe(0);
      expect(runStep).toHaveBeenCalled();
      for (const [invocation] of runStep.mock.calls) {
        expect(invocation.options.env).toMatchObject(partialEnv);
        expect(invocation.options.env.OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB).toBeUndefined();
      }
    },
  );

  it.each([
    {
      label: "cgroup cap",
      env: {},
      cgroupGiB: 7,
      heapMb: 6400,
      nodeOptions: "--max-old-space-size=6400",
      warns: false,
    },
    {
      label: "CI ambient heap above the cgroup budget",
      env: { NODE_OPTIONS: "--max-old-space-size=8192" },
      cgroupGiB: 7,
      heapMb: 6400,
      nodeOptions: "--max-old-space-size=6400",
      warns: false,
    },
    {
      label: "explicit override",
      env: {
        NODE_OPTIONS: "--trace-warnings --max-old-space-size=8192",
        OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "4096",
      },
      cgroupGiB: 4,
      heapMb: 4096,
      nodeOptions: "--trace-warnings --max-old-space-size=4096",
      warns: true,
    },
  ])(
    "hands the cold ciArtifacts writer an effective child heap from $label",
    async ({ env, cgroupGiB, heapMb, nodeOptions, warns }) => {
      const invocations: ReturnType<typeof resolveBuildAllStep>[] = [];
      const logger = { error: vi.fn(), warn: vi.fn() };
      const result = await runBuildAllSteps("ciArtifacts", {
        env,
        logger,
        memoryLimit: buildMemoryLimit(cgroupGiB),
        resolveCacheState: () => ({ cacheable: true, fresh: false, reason: "missing-inputs" }),
        finalizeCache: vi.fn(() => true),
        runStep(invocation) {
          invocations.push(invocation);
          return { status: 0 };
        },
      });
      expect(result.exitCode).toBe(0);
      const writer = expectDefined(
        invocations.find((invocation) =>
          invocation.args.includes("scripts/write-plugin-sdk-entry-dts.ts"),
        ),
        "SDK declaration writer invocation",
      );
      expect(writer.options.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe("0");

      // Probe the writer's actual launch environment without compiling the declaration graph.
      // A CLI flag supplies an independent reference across Node versions' V8 overheads.
      const probeArgs = ["-p", 'require("node:v8").getHeapStatistics().heap_size_limit'];
      const probeOptions = {
        ...writer.options,
        stdio: "pipe" as const,
        encoding: "utf8" as const,
        timeout: 10_000,
      };
      const actual = spawnSync(writer.command, probeArgs, probeOptions);
      const expected = spawnSync(
        writer.command,
        [`--max-old-space-size=${heapMb}`, ...probeArgs],
        probeOptions,
      );
      expect(actual.status, actual.stderr).toBe(0);
      expect(expected.status, expected.stderr).toBe(0);
      expect(Number(actual.stdout)).toBe(Number(expected.stdout));
      for (const invocation of invocations) {
        expect(invocation.options.env.NODE_OPTIONS).toBe(nodeOptions);
        expect(invocation.options.env.OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB).toBe(String(heapMb));
      }
      expect(logger.warn).toHaveBeenCalledTimes(warns ? 1 : 0);
    },
  );

  it("rebuilds runtime JS while reusing fresh declaration groups", () => {
    const ai = getBuildAllStep("tsdown-ai");
    const packages = getBuildAllStep("tsdown-packages");
    const unified = getBuildAllStep("tsdown-unified");

    expect(ai.args).toEqual([
      "--import",
      "tsx",
      "scripts/tsdown-build.mts",
      "--config",
      "tsdown.ai.config.ts",
    ]);
    expect(packages.args).toEqual(
      expect.arrayContaining(["--config", "tsdown.config.ts", "--filter", "openclaw-packages"]),
    );
    expect(unified.args).toEqual([
      "--import",
      "tsx",
      "scripts/tsdown-build.mts",
      "--config",
      "tsdown.config.ts",
      "--filter",
      TSDOWN_UNIFIED_CONFIG_GROUP,
    ]);
    expect(unified.env).toMatchObject({ OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" });
    expect(unified.cache).toBeUndefined();
    for (const step of [ai, packages]) {
      expect(step.cache?.restore).toBe("always");
      expect(step.cache?.runOnHit?.env).toEqual({ OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" });
      expect(resolveBuildAllStepOnCacheHit(step)?.env).toMatchObject({
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      });
      expect(step.cache?.outputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ extensions: [".d.ts", ".d.mts", ".d.cts"] }),
        ]),
      );
    }
  });

  it("uses a runtime artifact plus plugin SDK export profile for ci artifacts", () => {
    expect(resolveBuildAllSteps("ciArtifacts").map((step) => step.label)).toEqual([
      "plugins:assets:build",
      "tsdown",
      "external-plugins:local-dist",
      "check-cli-bootstrap-imports",
      "plugins:assets:copy",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
      "write-plugin-sdk-entry-dts",
      "check-plugin-sdk-exports",
      "ui:build",
      "write-build-info",
      "write-cli-startup-metadata",
    ]);
  });

  it("skips bundled tsdown declarations for runtime-only profiles", () => {
    for (const profile of [
      "gatewayWatch",
      "qaRuntime",
      "sourcePerformance",
      "cliStartup",
    ] as const) {
      const tsdown = resolveBuildAllSteps(profile).find((step) => step.label === "tsdown");
      if (!tsdown) {
        throw new Error(`Missing ${profile} tsdown step`);
      }

      expect(
        expectDefined(BUILD_ALL_PROFILE_STEP_ENV[profile], `${profile} build step env`).tsdown,
      ).toMatchObject({
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      });
      expect(
        resolveBuildAllStep(tsdown, { env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" } }).options.env,
      ).toMatchObject({
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      });
    }
  });

  it("shares the canonical staged SDK owner across full, package and CI artifacts", () => {
    const steps = resolveBuildAllSteps("ciArtifacts");
    const tsdown = expectDefined(
      steps.find((step) => step.label === "tsdown"),
      "runtime stage",
    );
    expect(resolveBuildAllStep(tsdown, { env: {} }).options.env).toMatchObject({
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    });
    const stage = expectDefined(
      steps.find((step) => step.label === "write-plugin-sdk-entry-dts"),
      "SDK declaration stage",
    );
    expect(stage.env).toMatchObject({ OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" });
    expect(stage.cache).toBeUndefined();
    for (const profile of ["full", "package"]) {
      const profileSteps = resolveBuildAllSteps(profile);
      expect(profileSteps.find((step) => step.label === stage.label)).toEqual(stage);
      const labels = profileSteps.map((step) => step.label);
      expect(labels.indexOf(stage.label)).toBeGreaterThan(labels.indexOf("tsdown-unified"));
      expect(labels.indexOf(stage.label)).toBeLessThan(labels.indexOf("check-plugin-sdk-exports"));
    }
  });

  it("preserves startup metadata only for profiles that regenerate it", () => {
    const fullTsdown = resolveBuildAllSteps("full").find((step) => step.label === "tsdown-unified");
    if (!fullTsdown) {
      throw new Error("Missing full tsdown-unified step");
    }
    expect(resolveBuildAllStep(fullTsdown, { env: {} }).options.env).toMatchObject({
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    });

    for (const profile of ["ciArtifacts", "sourcePerformance", "cliStartup"]) {
      const tsdown = resolveBuildAllSteps(profile).find((step) => step.label === "tsdown");
      if (!tsdown) {
        throw new Error(`Missing ${profile} tsdown step`);
      }

      expect(resolveBuildAllStep(tsdown, { env: {} }).options.env).toMatchObject({
        OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
      });
    }

    for (const profile of ["gatewayWatch", "qaRuntime"]) {
      const tsdown = resolveBuildAllSteps(profile).find((step) => step.label === "tsdown");
      if (!tsdown) {
        throw new Error(`Missing ${profile} tsdown step`);
      }

      expect(resolveBuildAllStep(tsdown, { env: {} }).options.env).not.toHaveProperty(
        "OPENCLAW_PRESERVE_CLI_STARTUP_METADATA",
      );
    }
  });

  it("uses a minimal built runtime profile for gateway watch regression", () => {
    expect(resolveBuildAllSteps("gatewayWatch").map((step) => step.label)).toEqual([
      "tsdown",
      "external-plugins:local-dist",
      "check-cli-bootstrap-imports",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
    ]);
  });

  it("uses a QA runtime profile with generated plugin assets but no startup metadata", () => {
    expect(resolveBuildAllSteps("qaRuntime").map((step) => step.label)).toEqual([
      "plugins:assets:build",
      "tsdown",
      "external-plugins:local-dist",
      "check-cli-bootstrap-imports",
      "plugins:assets:copy",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
    ]);
  });

  it.each([undefined, "0", "1"])(
    "preserves source-run declaration choice %s through the canonical runtime build",
    async (skipDts) => {
      const cwd = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-source-rebuild-")),
      );
      const childEnv = {
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: skipDts,
      };
      const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      });
      const postbuild = vi.fn();
      try {
        expect(
          await runNodeMain({
            cwd,
            env: childEnv,
            args: ["status"],
            spawn,
            spawnSync: () => ({ status: 1 }),
            stderr: { write: () => true },
            runRuntimePostBuild: postbuild,
          }),
        ).toBe(0);
        expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
          ["--import", "tsx", "scripts/build-all.mts", "qaRuntime"],
          ["openclaw.mjs", "status"],
        ]);
        const env = spawn.mock.calls[0]![2].env!;
        const invocations: ReturnType<typeof resolveBuildAllStep>[] = [];
        const result = await runBuildAllSteps("qaRuntime", {
          env,
          logger: { error: vi.fn(), warn: vi.fn() },
          resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
          runStep(invocation) {
            invocations.push(invocation);
            return { status: 0 };
          },
        });
        expect(result.exitCode).toBe(0);
        const compiler = invocations.find((call) =>
          call.args.includes("scripts/tsdown-build.mts"),
        )!;
        expect(compiler.options.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(skipDts ?? "1");
        expect(
          invocations.every((call) => call.options.env.OPENCLAW_BUILD_PRIVATE_QA === "1"),
        ).toBe(true);
        expect(result.timings.map(({ label }) => label)).toEqual([
          "plugins:assets:build",
          "tsdown",
          "external-plugins:local-dist",
          "check-cli-bootstrap-imports",
          "plugins:assets:copy",
          "runtime-postbuild",
          "build-stamp",
          "runtime-postbuild-stamp",
        ]);
        expect(postbuild).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(cwd, ".artifacts/run-node-build.lock"))).toBe(false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["external-plugins:local-dist", "scripts/build-external-plugin-local-dist.mts"],
    ["runtime-postbuild", "scripts/runtime-postbuild.mjs"],
  ])("does not stamp qaRuntime after %s fails", async (label, script) => {
    const invocations: ReturnType<typeof resolveBuildAllStep>[] = [];
    const result = await runBuildAllSteps("qaRuntime", {
      env: {},
      logger: { error: vi.fn(), warn: vi.fn() },
      resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
      runStep(invocation) {
        invocations.push(invocation);
        return { status: invocation.args.includes(script) ? 23 : 0 };
      },
    });

    expect(result.exitCode).toBe(23);
    expect(result.timings.at(-1)).toMatchObject({ label, status: "failed" });
    expect(invocations.at(-1)?.args).toContain(script);
    for (const invocation of invocations) {
      expect(invocation.args).not.toContain("scripts/build-stamp.mts");
      expect(invocation.args).not.toContain("scripts/runtime-postbuild-stamp.mts");
    }
  });

  it("uses the full runtime artifact surface without declaration work when DTS is disabled", () => {
    const steps = resolveBuildAllSteps("full", {
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    });
    const labels = steps.map((step) => step.label);

    expect(labels).toEqual([
      "plugins:assets:build",
      "tsdown",
      "external-plugins:local-dist",
      "check-cli-bootstrap-imports",
      "plugins:assets:copy",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
      "ui:build",
      "write-build-info",
      "write-cli-startup-metadata",
    ]);
    expect(steps.find((step) => step.label === "tsdown")?.cache).toBeUndefined();
    expect(labels).not.toContain("write-plugin-sdk-entry-dts");
    expect(labels).not.toContain("check-plugin-sdk-exports");
  });

  describe.each(["full", "package"])("%s runner build environment", (profile) => {
    it.each([
      { name: "ordinary build", env: {}, runtimeOnly: false, skipDts: undefined },
      {
        name: "runtime override",
        env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
        runtimeOnly: true,
        skipDts: "1",
      },
      {
        name: "legacy updater marker",
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
        runtimeOnly: true,
        skipDts: "1",
      },
      {
        name: "explicit declarations during update",
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
        runtimeOnly: false,
        skipDts: "0",
      },
    ])(
      "honors $name in selected steps and compiler children",
      async ({ env, runtimeOnly, skipDts }) => {
        const originalEnv = { ...env };
        const invocations: ReturnType<typeof resolveBuildAllStep>[] = [];
        const result = await runBuildAllSteps(profile, {
          cacheEnabled: false,
          env,
          logger: { error: vi.fn(), warn: vi.fn() },
          memoryLimit: buildMemoryLimit(5),
          now: () => 0,
          resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
          runStep(invocation) {
            invocations.push(invocation);
            return { status: 0 };
          },
        });

        expect(result.exitCode).toBe(0);
        const labels = result.timings.map((timing) => timing.label);
        expect(labels).toEqual(
          resolveBuildAllSteps(profile, {
            OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: runtimeOnly ? "1" : "0",
          }).map((step) => step.label),
        );
        expect(labels.includes("write-plugin-sdk-entry-dts")).toBe(!runtimeOnly);
        expect(labels.includes("write-unified-entry-dts")).toBe(!runtimeOnly);
        expect(labels.includes("check-plugin-sdk-exports")).toBe(!runtimeOnly);
        expect(labels.includes("clean:dist")).toBe(profile === "package");
        const compilers = invocations.filter((call) =>
          call.args.includes("scripts/tsdown-build.mts"),
        );
        expect(compilers).toHaveLength(runtimeOnly ? 1 : 3);
        for (const compiler of compilers) {
          expect(compiler.options.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(
            compiler.args.includes(TSDOWN_UNIFIED_CONFIG_GROUP) ? "1" : skipDts,
          );
        }
        expect(env).toEqual(originalEnv);
      },
    );
  });

  it("uses a source performance profile with QA assets and immutable build provenance", () => {
    expect(resolveBuildAllSteps("sourcePerformance").map((step) => step.label)).toEqual([
      "plugins:assets:build",
      "tsdown",
      "external-plugins:local-dist",
      "check-cli-bootstrap-imports",
      "plugins:assets:copy",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
      "write-build-info",
      "write-cli-startup-metadata",
    ]);
  });

  it("uses a CLI startup profile without generated plugin assets", () => {
    expect(resolveBuildAllSteps("cliStartup").map((step) => step.label)).toEqual([
      "tsdown",
      "external-plugins:local-dist",
      "check-cli-bootstrap-imports",
      "runtime-postbuild",
      "build-stamp",
      "runtime-postbuild-stamp",
      "write-cli-startup-metadata",
    ]);
  });

  it("skips generated static plugin assets for minimal backend-only profiles", () => {
    for (const profile of ["gatewayWatch", "cliStartup"] as const) {
      const runtimePostbuild = resolveBuildAllSteps(profile).find(
        (step) => step.label === "runtime-postbuild",
      );
      if (!runtimePostbuild) {
        throw new Error(`Missing ${profile} runtime-postbuild step`);
      }

      expect(
        expectDefined(BUILD_ALL_PROFILE_STEP_ENV[profile], `${profile} build step env`)[
          "runtime-postbuild"
        ],
      ).toEqual({
        OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
      });
      expect(
        resolveBuildAllStep(runtimePostbuild, {
          env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "1" },
        }).options.env,
      ).toMatchObject({
        OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
      });
    }
  });

  it("keeps generated static plugin assets enabled for QA-backed profiles", () => {
    for (const profile of ["qaRuntime", "sourcePerformance"] as const) {
      const runtimePostbuild = resolveBuildAllSteps(profile).find(
        (step) => step.label === "runtime-postbuild",
      );
      if (!runtimePostbuild) {
        throw new Error(`Missing ${profile} runtime-postbuild step`);
      }

      expect(
        expectDefined(BUILD_ALL_PROFILE_STEP_ENV[profile], `${profile} build step env`)[
          "runtime-postbuild"
        ],
      ).toBeUndefined();
      expect(
        resolveBuildAllStep(runtimePostbuild, {
          env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "1" },
        }).options.env,
      ).toMatchObject({
        OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "1",
      });
    }
  });

  it("copies generated plugin assets before runtime postbuild snapshots static outputs", () => {
    for (const profile of ["full", "package", "ciArtifacts", "qaRuntime", "sourcePerformance"]) {
      const labels = resolveBuildAllSteps(profile).map((step) => step.label);
      const lastTsdown = profile === "full" || profile === "package" ? "tsdown-unified" : "tsdown";
      expect(labels.indexOf("plugins:assets:copy")).toBeGreaterThan(labels.indexOf(lastTsdown));
      expect(labels.indexOf("runtime-postbuild")).toBeGreaterThan(
        labels.indexOf("plugins:assets:copy"),
      );
      expect(labels.indexOf("runtime-postbuild-stamp")).toBeGreaterThan(
        labels.indexOf("runtime-postbuild"),
      );
    }
  });

  it("builds isolated external plugin output after tsdown and before runtime postbuild", () => {
    for (const profile of Object.keys(BUILD_ALL_PROFILES)) {
      const labels = resolveBuildAllSteps(profile).map((step) => step.label);
      const lastTsdown = profile === "full" || profile === "package" ? "tsdown-unified" : "tsdown";
      expect(labels.indexOf("external-plugins:local-dist")).toBeGreaterThan(
        labels.indexOf(lastTsdown),
      );
      expect(labels.indexOf("external-plugins:local-dist")).toBeLessThan(
        labels.indexOf("runtime-postbuild"),
      );
    }
  });

  it("writes the runtime postbuild stamp after the build stamp", () => {
    const labels = resolveBuildAllSteps("full").map((step) => step.label);
    expect(labels).toContain("runtime-postbuild");
    expect(labels).toContain("build-stamp");
    expect(labels).toContain("runtime-postbuild-stamp");
    expect(labels.indexOf("runtime-postbuild-stamp")).toBeGreaterThan(
      labels.indexOf("build-stamp"),
    );
  });

  it("includes ui:build in the full and ciArtifacts profiles after runtime postbuild", () => {
    for (const profile of ["full", "package", "ciArtifacts"]) {
      const labels = resolveBuildAllSteps(profile).map((step) => step.label);
      const lastTsdown = profile === "full" || profile === "package" ? "tsdown-unified" : "tsdown";
      expect(labels).toContain("ui:build");
      // Control UI bundling must run after tsdown clears dist so that
      // dist/control-ui survives `pnpm build` without a second command.
      expect(labels.indexOf("ui:build")).toBeGreaterThan(labels.indexOf(lastTsdown));
      expect(labels.indexOf("ui:build")).toBeGreaterThan(labels.indexOf("runtime-postbuild-stamp"));
      // ui:build must run before write-build-info so the build manifest can
      // see the final dist/control-ui assets.
      expect(labels.indexOf("ui:build")).toBeLessThan(labels.indexOf("write-build-info"));
    }
  });

  it("keeps ui:build out of minimal backend-only profiles", () => {
    for (const profile of ["gatewayWatch", "qaRuntime", "sourcePerformance", "cliStartup"]) {
      const labels = resolveBuildAllSteps(profile).map((step) => step.label);
      expect(labels).not.toContain("ui:build");
    }
  });

  it("does not cache ui:build because Vite reads package.json, git HEAD, and env metadata", () => {
    // ui/vite.config.ts derives the Control UI build ID from package.json,
    // git HEAD, and OPENCLAW_CONTROL_UI_BUILD_ID env, so a file-input
    // signature cannot exactly invalidate generated assets. Leaving this
    // step uncached avoids restoring stale service-worker/app cache
    // metadata after `tsdown` clears `dist`.
    const step = getBuildAllStep("ui:build");
    expect(step.kind).toBe("pnpm");
    expect(step.pnpmArgs).toEqual(["ui:build"]);
    expect(step.cache).toBeUndefined();
  });

  it("rejects unknown build profiles", () => {
    expect(() => resolveBuildAllSteps("wat")).toThrow("Unknown build profile: wat");
  });
});

describe("build-all timing output", () => {
  it("formats short and long phase durations compactly", () => {
    expect(formatBuildAllDuration(42.4)).toBe("42ms");
    expect(formatBuildAllDuration(1234)).toBe("1.23s");
    expect(formatBuildAllDuration(12345)).toBe("12.3s");
  });

  it("summarizes phases slowest first with total time and status", () => {
    expect(
      formatBuildAllTimingSummary([
        { label: "tsdown", status: "ran", durationMs: 99000 },
        { label: "plugins:assets:copy", status: "cached", durationMs: 12 },
        { label: "write-plugin-sdk-entry-dts", status: "ran", durationMs: 34567 },
      ]),
    ).toBe(
      "[build-all] phase timings: total 2m 13.6s; slowest tsdown 1m 39s; write-plugin-sdk-entry-dts 34.6s; plugins:assets:copy (cached) 12ms",
    );
  });
});

describe("resolveBuildStepCacheState", () => {
  it("lists large nested inventories without an argument-count limit", () => {
    withBuildCacheFixture(({ rootDir }) => {
      // Builds run on the main Node thread; Vitest workers have a different stack budget.
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          "--input-type=module",
          "-e",
          `
            import assert from "node:assert/strict";
            import fs from "node:fs";
            import path from "node:path";
            import { listCacheFiles } from "./scripts/lib/build-artifact-cache.mts";
            const root = process.argv[1];
            const directory = path.join(root, "src");
            const [template] = fs.readdirSync(directory, { withFileTypes: true });
            const entries = Array.from({ length: 200_000 }, (_, index) =>
              new Proxy(template, {
                get(target, key, receiver) {
                  return key === "name" ? index + ".ts" : Reflect.get(target, key, receiver);
                },
              }),
            );
            const wideFs = new Proxy(fs, {
              get(target, key, receiver) {
                return key === "readdirSync"
                  ? (file, options) => file === directory ? entries : fs.readdirSync(file, options)
                  : Reflect.get(target, key, receiver);
              },
            });
            assert.deepEqual(
              listCacheFiles(root, [{ path: ".", extensions: [".ts"] }], wideFs),
              entries.map((entry) => path.join(directory, entry.name)).toSorted(),
            );
          `,
          rootDir,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(0);
    });
  });

  it("rejects a snapshot replaced after lookup without changing live outputs", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const state = resolveBuildStepCacheState(step, { rootDir });
      writeBuildStepCacheStamp(step, state, { rootDir });
      fs.rmSync(outputPath);
      const pendingRestore = resolveBuildStepCacheState(step, { rootDir });
      expect(pendingRestore.restorable).toBe(true);
      fs.writeFileSync(outputPath, "next complete generation");
      writeBuildStepCacheStamp(step, state, { rootDir });
      expect(restoreBuildStepCacheOutputs(pendingRestore, { rootDir })).toBe(false);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("next complete generation");
    });
  });

  it("invalidates publication before copying and never accepts a partial cached tree", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const state = resolveBuildStepCacheState(step, { rootDir });
      writeBuildStepCacheStamp(step, state, { rootDir });
      fs.writeFileSync(outputPath, "changed bytes");
      const rename = fs.renameSync.bind(fs);
      const fail = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
        if (String(target).startsWith(state.outputRoot!)) {
          expect(fs.existsSync(state.stampPath!)).toBe(false);
          throw new Error("fixture copy failure");
        }
        return rename(source, target);
      });
      try {
        expect(() => writeBuildStepCacheStamp(step, state, { rootDir })).toThrow(
          "fixture copy failure",
        );
      } finally {
        fail.mockRestore();
      }
      expect(fs.existsSync(state.stampPath!)).toBe(false);
      expect(resolveBuildStepCacheState(step, { rootDir })).toMatchObject({
        fresh: false,
        restorable: false,
      });
    });
  });

  it("restores exact declaration snapshots across checkout roots", () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shared-build-cache-"));
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-cache-source-"));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-cache-target-"));
    const step = {
      label: "tsdown-unified",
      cache: {
        inputs: ["src"],
        outputs: [{ path: "dist", extensions: [".d.ts", ".d.mts", ".d.cts"] }],
        restore: "always" as const,
      },
    };
    const env = { BUILD_ALL_CACHE_ROOT: cacheRoot };

    try {
      for (const rootDir of [firstRoot, secondRoot]) {
        fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
        fs.mkdirSync(path.join(rootDir, "dist/plugin-sdk"), { recursive: true });
        fs.writeFileSync(path.join(rootDir, "src/input.ts"), "same input");
      }
      const currentDts = path.join(secondRoot, "dist/plugin-sdk/current.d.ts");
      const removedDts = path.join(secondRoot, "dist/plugin-sdk/removed-facade.d.ts");
      const removedJs = path.join(secondRoot, "dist/plugin-sdk/removed-facade.js");
      fs.writeFileSync(
        path.join(firstRoot, "dist/plugin-sdk/current.d.ts"),
        "export declare const current: true;",
      );
      fs.writeFileSync(removedDts, "export declare const removed: true;");
      fs.writeFileSync(removedJs, "export const removed = true;");

      const sourceState = resolveBuildStepCacheState(step, { rootDir: firstRoot, env });
      writeBuildStepCacheStamp(
        step,
        resolveBuildStepCacheStampState(step, sourceState, { rootDir: firstRoot }),
        { rootDir: firstRoot },
      );

      const targetState = resolveBuildStepCacheState(step, { rootDir: secondRoot, env });
      expect(targetState).toMatchObject({ fresh: true, restorable: true });
      expect(targetState.outputRoot).toBe(path.join(cacheRoot, "tsdown-unified", "outputs"));
      expect(restoreBuildStepCacheOutputs(targetState, { rootDir: secondRoot })).toBe(true);
      fs.rmSync(removedJs);

      expect({
        current: fs.readFileSync(currentDts, "utf8"),
        declaration: fs.existsSync(removedDts),
        runtime: fs.existsSync(removedJs),
      }).toEqual({
        current: "export declare const current: true;",
        declaration: false,
        runtime: false,
      });
    } finally {
      fs.rmSync(cacheRoot, { force: true, recursive: true });
      fs.rmSync(firstRoot, { force: true, recursive: true });
      fs.rmSync(secondRoot, { force: true, recursive: true });
    }
  });

  it("keeps workspace declaration caches independent of core inputs", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tsdown-group-cache-"));
    const ai = getBuildAllStep("tsdown-ai");
    const packages = getBuildAllStep("tsdown-packages");
    const sourcePath = path.join(rootDir, "src/index.ts");
    const aiSourcePath = path.join(rootDir, "packages/ai/src/index.ts");
    const packageSourcePath = path.join(rootDir, "packages/net-policy/src/index.ts");
    const fixtures = [
      ["package.json", "{}"],
      ["src/index.ts", "export const core = 1;"],
      ["extensions/example/index.ts", "export const extension = 1;"],
      ["packages/ai/src/index.ts", "export const ai = 1;"],
      ["packages/net-policy/src/index.ts", "export const net = 1;"],
      ["packages/ai/dist/index.d.ts", "export declare const ai = 1;"],
      ["packages/net-policy/dist/index.d.ts", "export declare const net = 1;"],
    ] as const;

    try {
      for (const [relativePath, contents] of fixtures) {
        const filePath = path.join(rootDir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents);
      }
      for (const step of [ai, packages]) {
        const state = resolveBuildStepCacheState(step, { rootDir });
        writeBuildStepCacheStamp(step, resolveBuildStepCacheStampState(step, state, { rootDir }), {
          rootDir,
        });
      }

      fs.writeFileSync(sourcePath, "export const core = 2;");
      expect(resolveBuildStepCacheState(ai, { rootDir }).fresh).toBe(true);
      expect(resolveBuildStepCacheState(packages, { rootDir }).fresh).toBe(true);

      fs.writeFileSync(sourcePath, "export const core = 1;");
      fs.writeFileSync(packageSourcePath, "export const net = 2;");
      expect(resolveBuildStepCacheState(ai, { rootDir }).fresh).toBe(false);
      expect(resolveBuildStepCacheState(packages, { rootDir }).fresh).toBe(false);

      fs.writeFileSync(packageSourcePath, "export const net = 1;");
      fs.writeFileSync(aiSourcePath, "export const ai = 2;");
      expect(resolveBuildStepCacheState(ai, { rootDir }).fresh).toBe(false);
      expect(resolveBuildStepCacheState(packages, { rootDir }).fresh).toBe(false);
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it.each<{ name: string; before: NodeJS.ProcessEnv; after: NodeJS.ProcessEnv }>([
    { name: "bounded plugins", before: { OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "plain" }, after: {} },
    { name: "optional plugins", before: { OPENCLAW_INCLUDE_OPTIONAL_BUNDLED: "0" }, after: {} },
    {
      name: "Docker plugins",
      before: {},
      after: { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "external" },
    },
  ])("keeps workspace declaration signatures independent of $name", ({ before, after }) => {
    withBuildCacheFixture(({ rootDir }) => {
      for (const id of ["plain", "acpx", "external"]) {
        const directory = path.join(rootDir, "extensions", id);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "openclaw.plugin.json"), JSON.stringify({ id }));
        fs.writeFileSync(path.join(directory, "index.ts"), "export {};\n");
        fs.writeFileSync(
          path.join(directory, "package.json"),
          JSON.stringify({
            name: `@openclaw/${id}`,
            openclaw: { build: { bundledDist: id !== "external" } },
          }),
        );
      }
      expect(listBundledPluginBuildEntries({ cwd: rootDir, env: after })).not.toEqual(
        listBundledPluginBuildEntries({ cwd: rootDir, env: before }),
      );
      for (const label of ["tsdown-ai", "tsdown-packages"]) {
        const step = getBuildAllStep(label);
        expect(resolveBuildStepCacheState(step, { rootDir, env: after }).signature).toBe(
          resolveBuildStepCacheState(step, { rootDir, env: before }).signature,
        );
      }
    });
  });

  it("marks cacheable steps fresh when the input signature matches", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const cacheState = resolveBuildStepCacheState(step, { rootDir });
      expect(cacheState.reason).toBe("record-unavailable");
      writeBuildStepCacheStamp(step, cacheState, { rootDir });

      const fresh = resolveBuildStepCacheState(step, { rootDir });
      expect(fresh.cacheable).toBe(true);
      expect(fresh.fresh).toBe(true);
      expect(fresh.reason).toBe("fresh");
      expect(fresh.inputFiles).toBe(1);
      expect(fresh.outputFiles).toBe(1);
      expect(fresh.restorable).toBe(false);
      expect(fresh.relativeOutputFiles).toEqual(["dist/output.js"]);
      expect(fresh.stampedOutputs).toEqual(["dist/output.js"]);
      expect(typeof fresh.signature).toBe("string");
      expect(fresh.signature).toHaveLength(64);
      expect(fresh.outputRoot).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/outputs"),
      );
      expect(fresh.stampPath).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/stamp.json"),
      );
      expect(fresh).toEqual({
        cacheable: true,
        fresh: true,
        inputFiles: 1,
        outputFiles: 1,
        outputRoot: fresh.outputRoot,
        reason: "fresh",
        relativeOutputFiles: ["dist/output.js"],
        restorable: false,
        signature: fresh.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: fresh.stampPath,
        record: fresh.record,
      });
    });
  });

  it("rejects a matching legacy stamp that omits a required output", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const legacyState = resolveBuildStepCacheState(step, { rootDir });
      writeBuildStepCacheStamp(step, legacyState, { rootDir });
      const legacyStamp = JSON.parse(fs.readFileSync(legacyState.stampPath!, "utf8"));
      expect(legacyStamp).toMatchObject({
        version: 6,
        signature: legacyState.signature,
        outputs: { "dist/output.js": expect.any(String) },
      });
      fs.rmSync(path.join(rootDir, "dist"), { force: true, recursive: true });

      const completeStep = {
        ...step,
        cache: {
          ...step.cache,
          requiredOutputs: ["dist/output.js", "dist/plugin-sdk/core.d.ts"],
          restore: "always" as const,
        },
      };
      const stale = resolveBuildStepCacheState(completeStep, { rootDir });

      expect(stale).toMatchObject({
        fresh: false,
        reason: "required-output-unrecorded",
        restorable: false,
        signature: legacyState.signature,
        stampedOutputs: ["dist/output.js"],
      });
      expect(restoreBuildStepCacheOutputs(stale, { rootDir })).toBe(false);
    });
  });

  it("shares implicit and explicit declaration builds with the protected seed", () => {
    withBuildCacheFixture(({ rootDir }) => {
      for (const label of ["tsdown-ai", "tsdown-packages"]) {
        const declared = getBuildAllStep(label);
        const step = {
          ...declared,
          cache: {
            ...expectDefined(declared.cache, "declaration cache"),
            inputs: ["src"],
          },
        };
        const implicit = resolveBuildStepCacheState(step, { rootDir, env: {} });
        const explicit = resolveBuildStepCacheState(step, {
          rootDir,
          env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
        });
        expect(explicit.signature, label).toBe(implicit.signature);
      }
    });
  });

  it("does not replace a cache stamp from incomplete current outputs", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const initialState = resolveBuildStepCacheState(step, { rootDir });
      writeBuildStepCacheStamp(step, initialState, { rootDir });
      const stampBefore = fs.readFileSync(initialState.stampPath!, "utf8");
      const cachedOutputPath = path.join(initialState.outputRoot!, "dist/output.js");
      expect(fs.readFileSync(cachedOutputPath, "utf8")).toBe("output");

      fs.writeFileSync(outputPath, "incomplete refresh");
      const completeStep = {
        ...step,
        cache: {
          ...step.cache,
          requiredOutputs: ["dist/output.js", "dist/plugin-sdk/core.d.ts"],
        },
      };
      const incompleteState = resolveBuildStepCacheState(completeStep, { rootDir });
      expect(finalizeBuildStepCache(completeStep, incompleteState, { rootDir })).toBe(true);

      expect(fs.readFileSync(initialState.stampPath!, "utf8")).toBe(stampBefore);
      expect(fs.readFileSync(cachedOutputPath, "utf8")).toBe("output");
      expect(resolveBuildStepCacheState(completeStep, { rootDir })).toMatchObject({
        fresh: false,
        reason: "required-output-unrecorded",
      });
    });
  });

  it.each(["current", "legacy", "missing"])(
    "replaces obsolete cached outputs with a %s previous stamp",
    (stampKind) => {
      withBuildCacheFixture(({ rootDir, inputPath, step }) => {
        const obsolete = path.join(rootDir, "dist/obsolete.js");
        fs.writeFileSync(obsolete, "obsolete output");
        const initial = resolveBuildStepCacheState(step, { rootDir });
        writeBuildStepCacheStamp(step, initial, { rootDir });
        if (stampKind === "legacy") {
          const record = JSON.parse(fs.readFileSync(initial.stampPath!, "utf8"));
          fs.writeFileSync(initial.stampPath!, JSON.stringify({ ...record, version: 5 }));
        } else if (stampKind === "missing") {
          fs.rmSync(initial.stampPath!);
        }
        fs.rmSync(obsolete);
        fs.writeFileSync(inputPath, "changed input");

        const refreshed = resolveBuildStepCacheState(step, { rootDir });
        expect(refreshed.reason).toBe(
          stampKind === "current" ? "signature-mismatch" : "record-unavailable",
        );
        writeBuildStepCacheStamp(step, refreshed, { rootDir });

        expect(fs.readdirSync(path.join(refreshed.outputRoot!, "dist"))).toEqual(["output.js"]);
        expect(resolveBuildStepCacheState(step, { rootDir }).fresh).toBe(true);
      });
    },
  );

  it.each([
    { change: "input changed", reason: "signature-mismatch" },
    { change: "cached output changed", reason: "output-digest-mismatch" },
    { change: "cached output removed", reason: "output-missing-or-unreadable" },
  ])("reports stale cache state after $change", ({ change, reason }) => {
    withBuildCacheFixture(({ rootDir, inputPath, step }) => {
      const restoreStep = { ...step, cache: { ...step.cache, restore: "always" as const } };
      const cacheState = resolveBuildStepCacheState(restoreStep, { rootDir });
      writeBuildStepCacheStamp(restoreStep, cacheState, { rootDir });
      const cachedOutput = path.join(cacheState.outputRoot!, "dist/output.js");
      if (change === "input changed") {
        fs.writeFileSync(inputPath, "changed");
      } else if (change === "cached output changed") {
        fs.writeFileSync(cachedOutput, "changed");
      } else {
        fs.rmSync(cachedOutput);
      }

      const stale = resolveBuildStepCacheState(restoreStep, { rootDir });
      expect(stale.cacheable).toBe(true);
      expect(stale.fresh).toBe(false);
      expect(stale.reason).toBe(reason);
      expect(stale.inputFiles).toBe(1);
      expect(stale.outputFiles).toBe(1);
      expect(stale.restorable).toBe(false);
      expect(restoreBuildStepCacheOutputs(stale, { rootDir })).toBe(false);
      expect(stale.relativeOutputFiles).toEqual(["dist/output.js"]);
      expect(stale.stampedOutputs).toEqual(["dist/output.js"]);
      expect(typeof stale.signature).toBe("string");
      expect(stale.signature).toHaveLength(64);
      expect(stale.outputRoot).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/outputs"),
      );
      expect(stale.stampPath).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/stamp.json"),
      );
      expect(stale).toEqual({
        cacheable: true,
        fresh: false,
        inputFiles: 1,
        outputFiles: 1,
        outputRoot: stale.outputRoot,
        reason,
        relativeOutputFiles: ["dist/output.js"],
        restorable: false,
        signature: stale.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: stale.stampPath,
        record: stale.record,
      });
    });
  });

  it("ignores generated and installed directories in broad cache inputs", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const ignoredDist = path.join(rootDir, "src/nested/dist/generated.ts");
      const ignoredModules = path.join(rootDir, "src/node_modules/dependency.ts");
      fs.mkdirSync(path.dirname(ignoredDist), { recursive: true });
      fs.mkdirSync(path.dirname(ignoredModules), { recursive: true });
      fs.writeFileSync(ignoredDist, "generated");
      fs.writeFileSync(ignoredModules, "dependency");
      const broadStep = {
        ...step,
        cache: {
          ...step.cache,
          inputs: [
            {
              path: "src",
              excludeDirectories: ["dist", "node_modules"],
              extensions: [".ts"],
            },
          ],
        },
      };
      const cacheState = resolveBuildStepCacheState(broadStep, { rootDir });
      writeBuildStepCacheStamp(broadStep, cacheState, { rootDir });

      fs.writeFileSync(ignoredDist, "changed generated output");
      fs.writeFileSync(ignoredModules, "changed installed dependency");
      const fresh = resolveBuildStepCacheState(broadStep, { rootDir });

      expect(fresh.fresh).toBe(true);
      expect(fresh.inputFiles).toBe(1);
    });
  });

  it("reuses the pre-run input signature when stamping successful cacheable steps", () => {
    withBuildCacheFixture(({ rootDir, step, inputPath }) => {
      const cacheState = resolveBuildStepCacheState(step, { rootDir });
      const readSpy = vi.spyOn(fs, "readFileSync");

      try {
        const stampState = resolveBuildStepCacheStampState(step, cacheState, { rootDir });
        writeBuildStepCacheStamp(step, stampState, { rootDir });

        expect(readSpy.mock.calls.map(([file]) => file)).not.toContain(inputPath);
        expect(stampState.signature).toBe(cacheState.signature);
        expect(stampState.relativeOutputFiles).toEqual(["dist/output.js"]);
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  it("separates cache generations by output-affecting environment", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const envStep = {
        ...step,
        cache: {
          ...step.cache,
          env: ["OPENCLAW_BUILD_PRIVATE_QA"],
          restore: "always" as const,
        },
      };
      const cacheState = resolveBuildStepCacheState(envStep, {
        rootDir,
        env: { OPENCLAW_BUILD_PRIVATE_QA: "1" },
      });
      writeBuildStepCacheStamp(envStep, cacheState, {
        rootDir,
        env: { OPENCLAW_BUILD_PRIVATE_QA: "1" },
      });

      const stale = resolveBuildStepCacheState(envStep, {
        rootDir,
        env: {},
      });
      expect(stale.cacheable).toBe(true);
      expect(stale.fresh).toBe(false);
      expect(stale.restorable).toBe(false);
      expect(stale.reason).toBe("signature-mismatch");
    });
  });

  it("restores cached outputs when generated files were removed", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const cacheState = resolveBuildStepCacheState(step, { rootDir });
      writeBuildStepCacheStamp(step, cacheState, { rootDir });
      fs.rmSync(path.join(rootDir, "dist"), { force: true, recursive: true });

      const restorable = resolveBuildStepCacheState(step, { rootDir });
      expect(restorable.cacheable).toBe(true);
      expect(restorable.fresh).toBe(true);
      expect(restorable.reason).toBe("fresh-cache");
      expect(restorable.inputFiles).toBe(1);
      expect(restorable.outputFiles).toBe(0);
      expect(restorable.restorable).toBe(true);
      expect(restorable.relativeOutputFiles).toEqual([]);
      expect(restorable.stampedOutputs).toEqual(["dist/output.js"]);
      expect(typeof restorable.signature).toBe("string");
      expect(restorable.signature).toHaveLength(64);
      expect(restorable.outputRoot).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/outputs"),
      );
      expect(restorable.stampPath).toBe(
        path.join(rootDir, ".artifacts/build-all-cache/cached/stamp.json"),
      );
      expect(restorable).toEqual({
        cacheable: true,
        fresh: true,
        inputFiles: 1,
        outputFiles: 0,
        outputRoot: restorable.outputRoot,
        reason: "fresh-cache",
        relativeOutputFiles: [],
        restorable: true,
        signature: restorable.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: restorable.stampPath,
        record: restorable.record,
      });
      expect(restoreBuildStepCacheOutputs(restorable, { rootDir })).toBe(true);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("output");
    });
  });

  it("restores cached outputs over existing outputs for always-restore steps", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const alwaysRestoreStep = {
        ...step,
        cache: {
          ...step.cache,
          restore: "always" as const,
        },
      };
      const cacheState = resolveBuildStepCacheState(alwaysRestoreStep, { rootDir });
      writeBuildStepCacheStamp(alwaysRestoreStep, cacheState, { rootDir });
      fs.writeFileSync(outputPath, "overwritten by earlier build step");

      const restorable = resolveBuildStepCacheState(alwaysRestoreStep, { rootDir });
      expect(restorable.cacheable).toBe(true);
      expect(restorable.fresh).toBe(true);
      expect(restorable.reason).toBe("fresh-cache");
      expect(restorable.outputFiles).toBe(1);
      expect(restorable.restorable).toBe(true);
      expect(restorable.relativeOutputFiles).toEqual(["dist/output.js"]);
      expect(restorable.stampedOutputs).toEqual(["dist/output.js"]);

      expect(restoreBuildStepCacheOutputs(restorable, { rootDir })).toBe(true);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("output");
    });
  });

  it("restores always-restore outputs after a cache-hit command cleans them", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const alwaysRestoreStep = {
        ...step,
        cache: {
          ...step.cache,
          restore: "always" as const,
        },
      };
      const cacheState = resolveBuildStepCacheState(alwaysRestoreStep, { rootDir });
      writeBuildStepCacheStamp(alwaysRestoreStep, cacheState, { rootDir });
      const restorable = resolveBuildStepCacheState(alwaysRestoreStep, { rootDir });

      fs.rmSync(outputPath);
      expect(
        finalizeBuildStepCache(alwaysRestoreStep, restorable, { rootDir, reusedCache: true }),
      ).toBe(true);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("output");
    });
  });

  it("refreshes validator cache outputs after a cache-hit command updates them", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const refreshStep = {
        ...step,
        cache: {
          ...step.cache,
          restore: "always" as const,
          runOnHit: { finalize: "refresh" as const },
        },
      };
      const cacheState = resolveBuildStepCacheState(refreshStep, { rootDir });
      writeBuildStepCacheStamp(refreshStep, cacheState, { rootDir });
      const restorable = resolveBuildStepCacheState(refreshStep, { rootDir });
      expect(restoreBuildStepCacheOutputs(restorable, { rootDir })).toBe(true);

      fs.writeFileSync(outputPath, "validated refresh");
      expect(finalizeBuildStepCache(refreshStep, restorable, { rootDir, reusedCache: true })).toBe(
        true,
      );
      fs.rmSync(outputPath);

      const refreshed = resolveBuildStepCacheState(refreshStep, { rootDir });
      expect(restoreBuildStepCacheOutputs(refreshed, { rootDir })).toBe(true);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("validated refresh");
    });
  });

  it("can cache only direct directory files for generated flat outputs", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const nestedPath = path.join(rootDir, "dist/nested/output.d.ts");
      fs.mkdirSync(path.dirname(nestedPath), { recursive: true });
      fs.writeFileSync(path.join(rootDir, "dist/output.js"), "ignored");
      fs.writeFileSync(path.join(rootDir, "dist/output.d.ts"), "flat");
      fs.writeFileSync(nestedPath, "nested");

      const flatOnlyStep = {
        ...step,
        cache: {
          ...step.cache,
          outputs: [{ path: "dist", extensions: [".d.ts"], recursive: false }],
        },
      };

      const cacheState = resolveBuildStepCacheState(flatOnlyStep, { rootDir });
      expect(cacheState.relativeOutputFiles).toEqual(["dist/output.d.ts"]);
    });
  });
});
