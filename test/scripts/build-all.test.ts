// Build All tests cover build all script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  BUILD_ALL_PROFILES,
  BUILD_ALL_PROFILE_STEP_ENV,
  BUILD_ALL_STEPS,
  finalizeBuildAllStepCache,
  formatBuildAllDuration,
  formatBuildAllTimingSummary,
  parseBuildAllArgs,
  resolveBuildAllEnvironment,
  resolveBuildAllStepCacheState,
  resolveBuildAllStepCacheStampState,
  resolveBuildAllStep,
  resolveBuildAllStepOnCacheHit,
  resolveBuildAllSteps,
  resolveBuildAllTsdownPlan,
  restoreBuildAllStepCacheOutputs,
  runBuildAllSteps,
  writeBuildAllStepCacheStamp,
} from "../../scripts/build-all.mts";
import {
  listPluginSdkDistArtifacts,
  listPluginSdkDeclarationOutputs,
  pluginSdkEntrypoints,
} from "../../scripts/lib/plugin-sdk-entries.mts";

function getBuildAllStep(label: string) {
  const step = BUILD_ALL_STEPS.find((entry) => entry.label === label);
  if (!step) {
    throw new Error(`Missing build-all step ${label}`);
  }
  return step;
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
        requiredCacheHitOutputs?: string[];
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
      },
    });
  });

  it.each([
    {
      label: "write-plugin-sdk-entry-dts",
      scriptPath: "scripts/write-plugin-sdk-entry-dts.ts",
      expectedEnv: { FOO: "bar", OPENCLAW_PLUGIN_SDK_CANONICAL_DTS: "1" },
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
      },
    });
  });

  it("can route pnpm script steps through direct node entrypoints", () => {
    const step = getBuildAllStep("plugins:assets:build");

    const result = resolveBuildAllStep(step, {
      nodeExecPath: "/custom/node",
      env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
    });

    expect(result).toEqual({
      command: "/custom/node",
      args: ["--import", "tsx", "scripts/bundled-plugin-assets.mts", "--phase", "build"],
      options: {
        stdio: "inherit",
        env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
      },
    });
  });

  it("routes no-pnpm UI builds through the canonical validation wrapper", () => {
    expect(
      resolveBuildAllStep(getBuildAllStep("ui:build"), {
        nodeExecPath: "/custom/node",
        env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
      }),
    ).toEqual({
      command: "/custom/node",
      args: ["scripts/ui.js", "build"],
      options: {
        stdio: "inherit",
        env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
      },
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
    (profile) => {
      const runStep = vi.fn(() => ({ status: 0 }));
      const resolveCacheState = vi.fn(() => ({
        cacheable: false,
        fresh: false,
        reason: "no-cache",
      }));
      const restoreCache = vi.fn();
      const finalizeCache = vi.fn();
      const logger = { error: vi.fn(), warn: vi.fn() };

      const result = runBuildAllSteps(profile, {
        env: {},
        logger,
        memoryLimit: { cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024 },
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

  it.each(["full", "package"])("admits %s once and freezes its heap for every child", (profile) => {
    const tsdownSteps = resolveBuildAllSteps(profile).filter((step) =>
      step.label.startsWith("tsdown-"),
    );
    const tsdownInvocations: ReturnType<typeof resolveBuildAllStep>[] = [];
    const executionOrder: string[] = [];
    const restoreCache = vi.fn();
    const result = runBuildAllSteps(profile, {
      cacheEnabled: true,
      env: {},
      finalizeCache: vi.fn(),
      logger: { error: vi.fn(), warn: vi.fn() },
      memoryLimit: { cgroupMemoryLimitBytes: 5 * 1024 * 1024 * 1024 },
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
    expect(tsdownInvocations).toHaveLength(3);
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
    ]);

    const cacheDisabledRunner = vi.fn(() => ({ status: 0 }));
    runBuildAllSteps("ciArtifacts", {
      env: { OPENCLAW_BUILD_CACHE: "0" },
      memoryLimit: { cgroupMemoryLimitBytes: 5 * 1024 * 1024 * 1024 },
      finalizeCache: vi.fn(),
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
      }),
      runStep: cacheDisabledRunner,
      steps: [expectDefined(tsdownSteps[0], "first tsdown step")],
    });
    expect(cacheDisabledRunner).toHaveBeenCalledOnce();
  });

  it.each(["gatewayWatch", "qaRuntime", "sourcePerformance", "cliStartup"])(
    "skips heap admission for partial profile %s",
    (profile) => {
      const partialEnv = { MARKER: "unchanged", NODE_OPTIONS: "--max-old-space-size=256" };
      expect(
        resolveBuildAllTsdownPlan(profile, partialEnv, {
          cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024,
        }),
      ).toEqual({ env: partialEnv, heapShortfall: null });
      const runStep = vi.fn<
        (invocation: ReturnType<typeof resolveBuildAllStep>) => { status: number }
      >(() => ({ status: 0 }));
      const result = runBuildAllSteps(profile, {
        env: partialEnv,
        logger: { error: vi.fn(), warn: vi.fn() },
        memoryLimit: { cgroupMemoryLimitBytes: 4 * 1024 * 1024 * 1024 },
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
    ({ env, cgroupGiB, heapMb, nodeOptions, warns }) => {
      const invocations: ReturnType<typeof resolveBuildAllStep>[] = [];
      const logger = { error: vi.fn(), warn: vi.fn() };
      const result = runBuildAllSteps("ciArtifacts", {
        env,
        logger,
        memoryLimit: {
          platform: "linux",
          availableMemoryBytes: 16 * 1024 ** 3,
          procMemTotalBytes: 16 * 1024 ** 3,
          cgroupMemoryLimitBytes: cgroupGiB * 1024 ** 3,
        },
        resolveCacheState: () => ({ cacheable: true, fresh: false, reason: "missing-inputs" }),
        finalizeCache: vi.fn(),
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
      expect(writer.options.env.OPENCLAW_PLUGIN_SDK_CANONICAL_DTS).toBe("0");

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
    expect(unified.args).toEqual(
      expect.arrayContaining(["--config", "tsdown.config.ts", "--filter", "openclaw-unified"]),
    );
    for (const step of [ai, packages, unified]) {
      expect(step.cache?.restore).toBe("always");
      expect(step.cache?.env).toContain("OPENCLAW_RUN_NODE_SKIP_DTS_BUILD");
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
    expect(unified.cache?.env).toContain("OPENCLAW_BUILD_PRIVATE_QA");
    expect(unified.cache?.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src",
          extensions: expect.arrayContaining([".sql"]),
        }),
      ]),
    );
    const requiredOutputs = unified.cache?.requiredOutputs;
    if (typeof requiredOutputs !== "function") {
      throw new Error("Missing tsdown-unified required output resolver");
    }
    const productionOutputs = requiredOutputs({});
    const privateQaOutputs = requiredOutputs({ OPENCLAW_BUILD_PRIVATE_QA: "1" });
    expect(productionOutputs).toEqual(listPluginSdkDeclarationOutputs());
    expect(privateQaOutputs).toEqual(listPluginSdkDeclarationOutputs(pluginSdkEntrypoints));
    expect(productionOutputs).toContain("dist/plugin-sdk/core.d.ts");
    expect(productionOutputs).toContain("dist/plugin-sdk/provider-auth-runtime.d.ts");
    expect(productionOutputs).not.toContain("dist/plugin-sdk/test-fixtures.d.ts");
    expect(privateQaOutputs).toContain("dist/plugin-sdk/test-fixtures.d.ts");
    expect(unified.cache?.requiredCacheHitOutputs).toEqual(listPluginSdkDistArtifacts());
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

  it("skips global declarations on CI artifacts and self-builds the plugin-sdk gate", () => {
    // Global dts emission is ~95% of the tsdown wall clock; PR CI dist
    // consumers are runtime JS, and the plugin-sdk export gate validates
    // self-built scoped declarations instead. Release/package builds keep
    // canonical declarations (full profile, docker packaging).
    const steps = resolveBuildAllSteps("ciArtifacts");
    const tsdown = steps.find((step) => step.label === "tsdown");
    if (!tsdown) {
      throw new Error("Missing ciArtifacts tsdown step");
    }
    expect(resolveBuildAllStep(tsdown, { env: {} }).options.env).toMatchObject({
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    });

    const entryDts = steps.find((step) => step.label === "write-plugin-sdk-entry-dts");
    if (!entryDts) {
      throw new Error("Missing ciArtifacts write-plugin-sdk-entry-dts step");
    }
    expect(entryDts.env).toMatchObject({ OPENCLAW_PLUGIN_SDK_CANONICAL_DTS: "0" });
    expect(entryDts.cache?.inputs).toEqual(
      expect.arrayContaining([
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.plugin-sdk.dts.json",
        expect.objectContaining({
          path: "src",
          excludeDirectories: ["dist", "node_modules"],
        }),
        expect.objectContaining({
          path: "packages",
          excludeDirectories: ["dist", "node_modules"],
        }),
      ]),
    );
    expect(entryDts.cache?.outputs).toEqual(
      expect.arrayContaining([
        { path: "dist/plugin-sdk", extensions: [".d.ts"], recursive: false },
        "dist/plugin-sdk/.boundary-entry-shims.stamp",
      ]),
    );
    expect(entryDts.cache?.restore).toBe("always");

    const fullEntryDts = resolveBuildAllSteps("full").find(
      (step) => step.label === "write-plugin-sdk-entry-dts",
    );
    expect(fullEntryDts?.env).toMatchObject({ OPENCLAW_PLUGIN_SDK_CANONICAL_DTS: "1" });
    expect(fullEntryDts?.cache).toBeDefined();
    expect(fullEntryDts?.cache?.inputs).not.toContainEqual(
      expect.objectContaining({ path: "src" }),
    );
    expect(fullEntryDts?.cache?.outputs).not.toContainEqual({
      path: "dist/plugin-sdk",
      extensions: [".d.ts"],
      recursive: false,
    });
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
    ])("honors $name in selected steps and compiler children", ({ env, runtimeOnly, skipDts }) => {
      const originalEnv = { ...env };
      const invocations: ReturnType<typeof resolveBuildAllStep>[] = [];
      const result = runBuildAllSteps(profile, {
        cacheEnabled: false,
        env,
        logger: { error: vi.fn(), warn: vi.fn() },
        memoryLimit: { cgroupMemoryLimitBytes: 5 * 1024 * 1024 * 1024 },
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
      expect(labels.includes("check-plugin-sdk-exports")).toBe(!runtimeOnly);
      expect(labels.includes("clean:dist")).toBe(profile === "package");
      const compilers = invocations.filter((call) =>
        call.args.includes("scripts/tsdown-build.mts"),
      );
      expect(compilers).toHaveLength(runtimeOnly ? 1 : 3);
      for (const compiler of compilers) {
        expect(compiler.options.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD).toBe(skipDts);
      }
      expect(env).toEqual(originalEnv);
    });
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

  it("caches plugin-sdk entry declarations without restoring compiled JS", () => {
    const step = getBuildAllStep("write-plugin-sdk-entry-dts");
    expect(step.env).toEqual({ OPENCLAW_PLUGIN_SDK_CANONICAL_DTS: "1" });
    expect(step.cache?.env).toEqual([
      "OPENCLAW_BUILD_PRIVATE_QA",
      "OPENCLAW_PLUGIN_SDK_CANONICAL_DTS",
    ]);
    expect(step.cache?.inputs).toEqual(
      expect.arrayContaining([
        "scripts/write-plugin-sdk-entry-dts.ts",
        "scripts/lib/plugin-sdk-entrypoints.json",
        { path: "dist/plugin-sdk", extensions: [".d.ts"], recursive: false },
      ]),
    );
    expect(step.cache?.inputs).not.toContain("src/plugin-sdk");
    expect(step.cache?.outputs).toEqual(
      expect.arrayContaining([
        "dist/plugin-sdk/.boundary-entry-shims.stamp",
        "packages/plugin-sdk/dist/src/plugin-sdk/provider-entry.d.ts",
      ]),
    );
    expect(step.cache?.outputs).not.toContainEqual(
      expect.objectContaining({ path: "dist/plugin-sdk" }),
    );
    expect(step.cache?.restore).toBe("always");
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

describe("resolveBuildAllStepCacheState", () => {
  it.each([
    "scripts/lib/declaration-source-index.mts",
    "scripts/lib/direct-run.mjs",
    "scripts/lib/local-build-metadata-paths.mts",
    "scripts/lib/official-external-plugin-catalog.json",
    "node-version.d.mts",
    "test/helpers/provider-http.ts",
  ])("invalidates self-built SDK declarations when %s changes", (relativePath) => {
    withBuildCacheFixture(({ rootDir }) => {
      const step = expectDefined(
        resolveBuildAllSteps("ciArtifacts").find(
          (entry) => entry.label === "write-plugin-sdk-entry-dts",
        ),
        "self-built declarations step",
      );
      const input = path.join(rootDir, relativePath);
      const output = path.join(rootDir, "dist/plugin-sdk/core.d.ts");
      fs.mkdirSync(path.dirname(input), { recursive: true });
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(input, "before");
      fs.writeFileSync(output, "export {};");
      const state = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, state, { rootDir });
      expect(resolveBuildAllStepCacheState(step, { rootDir }).fresh).toBe(true);

      fs.writeFileSync(input, "after");
      expect(resolveBuildAllStepCacheState(step, { rootDir }).fresh).toBe(false);
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

      const sourceState = resolveBuildAllStepCacheState(step, { rootDir: firstRoot, env });
      writeBuildAllStepCacheStamp(
        step,
        resolveBuildAllStepCacheStampState(step, sourceState, { rootDir: firstRoot }),
        { rootDir: firstRoot },
      );

      const targetState = resolveBuildAllStepCacheState(step, { rootDir: secondRoot, env });
      expect(targetState).toMatchObject({ fresh: true, restorable: true });
      expect(targetState.outputRoot).toBe(path.join(cacheRoot, "tsdown-unified", "outputs"));
      expect(restoreBuildAllStepCacheOutputs(targetState, { rootDir: secondRoot })).toBe(true);
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

  it("invalidates only declaration groups that depend on the changed module", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tsdown-group-cache-"));
    const ai = getBuildAllStep("tsdown-ai");
    const packages = getBuildAllStep("tsdown-packages");
    const unified = getBuildAllStep("tsdown-unified");
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
      ["dist/index.d.ts", "export declare const core = 1;"],
    ] as const;

    try {
      for (const [relativePath, contents] of fixtures) {
        const filePath = path.join(rootDir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents);
      }
      for (const step of [ai, packages, unified]) {
        const state = resolveBuildAllStepCacheState(step, { rootDir });
        writeBuildAllStepCacheStamp(
          step,
          resolveBuildAllStepCacheStampState(step, state, { rootDir }),
          { rootDir },
        );
      }

      fs.writeFileSync(sourcePath, "export const core = 2;");
      expect(resolveBuildAllStepCacheState(ai, { rootDir }).fresh).toBe(true);
      expect(resolveBuildAllStepCacheState(packages, { rootDir }).fresh).toBe(true);
      expect(resolveBuildAllStepCacheState(unified, { rootDir }).fresh).toBe(false);

      fs.writeFileSync(sourcePath, "export const core = 1;");
      fs.writeFileSync(packageSourcePath, "export const net = 2;");
      expect(resolveBuildAllStepCacheState(ai, { rootDir }).fresh).toBe(false);
      expect(resolveBuildAllStepCacheState(packages, { rootDir }).fresh).toBe(false);
      expect(resolveBuildAllStepCacheState(unified, { rootDir }).fresh).toBe(false);

      fs.writeFileSync(packageSourcePath, "export const net = 1;");
      fs.writeFileSync(aiSourcePath, "export const ai = 2;");
      expect(resolveBuildAllStepCacheState(ai, { rootDir }).fresh).toBe(false);
      expect(resolveBuildAllStepCacheState(packages, { rootDir }).fresh).toBe(false);
      expect(resolveBuildAllStepCacheState(unified, { rootDir }).fresh).toBe(false);
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("marks cacheable steps fresh when the input signature matches", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });

      const fresh = resolveBuildAllStepCacheState(step, { rootDir });
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
      });
    });
  });

  it("rejects a matching legacy stamp that omits a required output", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const legacyState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, legacyState, { rootDir });
      const legacyStamp = JSON.parse(fs.readFileSync(legacyState.stampPath!, "utf8"));
      expect(legacyStamp).toMatchObject({
        version: 4,
        signature: legacyState.signature,
        outputs: ["dist/output.js"],
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
      const stale = resolveBuildAllStepCacheState(completeStep, { rootDir });

      expect(stale).toMatchObject({
        fresh: false,
        reason: "stale",
        restorable: false,
        signature: legacyState.signature,
        stampedOutputs: ["dist/output.js"],
      });
      expect(restoreBuildAllStepCacheOutputs(stale, { rootDir })).toBe(false);
    });
  });

  it("rejects a cache hit when a required live output was removed", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const declarationPath = path.join(rootDir, "dist/output.d.ts");
      fs.writeFileSync(declarationPath, "export declare const output: true;");
      const guardedStep = {
        ...step,
        cache: {
          ...step.cache,
          outputs: [{ path: "dist", extensions: [".d.ts"] }],
          requiredCacheHitOutputs: ["dist/output.js"],
          restore: "always" as const,
        },
      };
      const cacheState = resolveBuildAllStepCacheState(guardedStep, { rootDir });
      writeBuildAllStepCacheStamp(guardedStep, cacheState, { rootDir });

      expect(resolveBuildAllStepCacheState(guardedStep, { rootDir })).toMatchObject({
        fresh: true,
        restorable: true,
      });
      fs.rmSync(outputPath);

      expect(resolveBuildAllStepCacheState(guardedStep, { rootDir })).toMatchObject({
        fresh: false,
        reason: "stale",
        restorable: false,
      });
    });
  });

  it("does not replace a cache stamp from incomplete current outputs", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const initialState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, initialState, { rootDir });
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
      const incompleteState = resolveBuildAllStepCacheState(completeStep, { rootDir });
      expect(finalizeBuildAllStepCache(completeStep, incompleteState, { rootDir })).toBe(true);

      expect(fs.readFileSync(initialState.stampPath!, "utf8")).toBe(stampBefore);
      expect(fs.readFileSync(cachedOutputPath, "utf8")).toBe("output");
      expect(resolveBuildAllStepCacheState(completeStep, { rootDir })).toMatchObject({
        fresh: false,
        reason: "stale",
      });
    });
  });

  it("marks cacheable steps stale when an input changes", () => {
    withBuildCacheFixture(({ rootDir, inputPath, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });
      fs.writeFileSync(inputPath, "changed");

      const stale = resolveBuildAllStepCacheState(step, { rootDir });
      expect(stale.cacheable).toBe(true);
      expect(stale.fresh).toBe(false);
      expect(stale.reason).toBe("stale");
      expect(stale.inputFiles).toBe(1);
      expect(stale.outputFiles).toBe(1);
      expect(stale.restorable).toBe(false);
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
        reason: "stale",
        relativeOutputFiles: ["dist/output.js"],
        restorable: false,
        signature: stale.signature,
        stampedOutputs: ["dist/output.js"],
        stampPath: stale.stampPath,
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
      const cacheState = resolveBuildAllStepCacheState(broadStep, { rootDir });
      writeBuildAllStepCacheStamp(broadStep, cacheState, { rootDir });

      fs.writeFileSync(ignoredDist, "changed generated output");
      fs.writeFileSync(ignoredModules, "changed installed dependency");
      const fresh = resolveBuildAllStepCacheState(broadStep, { rootDir });

      expect(fresh.fresh).toBe(true);
      expect(fresh.inputFiles).toBe(1);
    });
  });

  it("reuses the pre-run input signature when stamping successful cacheable steps", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      const readSpy = vi.spyOn(fs, "readFileSync");

      try {
        const stampState = resolveBuildAllStepCacheStampState(step, cacheState, { rootDir });
        writeBuildAllStepCacheStamp(step, stampState, { rootDir });

        expect(readSpy).not.toHaveBeenCalled();
        expect(stampState.signature).toBe(cacheState.signature);
        expect(stampState.relativeOutputFiles).toEqual(["dist/output.js"]);
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  it("never reuses a runtime-only cache as a declaration-complete full-build cache", () => {
    withBuildCacheFixture(({ rootDir, step }) => {
      const envStep = {
        ...step,
        cache: {
          ...step.cache,
          env: ["OPENCLAW_RUN_NODE_SKIP_DTS_BUILD"],
          restore: "always" as const,
        },
      };
      const cacheState = resolveBuildAllStepCacheState(envStep, {
        rootDir,
        env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
      });
      writeBuildAllStepCacheStamp(envStep, cacheState, {
        rootDir,
        env: { OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1" },
      });

      const stale = resolveBuildAllStepCacheState(envStep, {
        rootDir,
        env: {},
      });
      expect(stale.cacheable).toBe(true);
      expect(stale.fresh).toBe(false);
      expect(stale.restorable).toBe(false);
      expect(stale.reason).toBe("stale");
    });
  });

  it("restores cached outputs when generated files were removed", () => {
    withBuildCacheFixture(({ rootDir, outputPath, step }) => {
      const cacheState = resolveBuildAllStepCacheState(step, { rootDir });
      writeBuildAllStepCacheStamp(step, cacheState, { rootDir });
      fs.rmSync(path.join(rootDir, "dist"), { force: true, recursive: true });

      const restorable = resolveBuildAllStepCacheState(step, { rootDir });
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
      });
      expect(restoreBuildAllStepCacheOutputs(restorable, { rootDir })).toBe(true);
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
      const cacheState = resolveBuildAllStepCacheState(alwaysRestoreStep, { rootDir });
      writeBuildAllStepCacheStamp(alwaysRestoreStep, cacheState, { rootDir });
      fs.writeFileSync(outputPath, "overwritten by earlier build step");

      const restorable = resolveBuildAllStepCacheState(alwaysRestoreStep, { rootDir });
      expect(restorable.cacheable).toBe(true);
      expect(restorable.fresh).toBe(true);
      expect(restorable.reason).toBe("fresh-cache");
      expect(restorable.outputFiles).toBe(1);
      expect(restorable.restorable).toBe(true);
      expect(restorable.relativeOutputFiles).toEqual(["dist/output.js"]);
      expect(restorable.stampedOutputs).toEqual(["dist/output.js"]);

      expect(restoreBuildAllStepCacheOutputs(restorable, { rootDir })).toBe(true);
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
      const cacheState = resolveBuildAllStepCacheState(alwaysRestoreStep, { rootDir });
      writeBuildAllStepCacheStamp(alwaysRestoreStep, cacheState, { rootDir });
      const restorable = resolveBuildAllStepCacheState(alwaysRestoreStep, { rootDir });

      fs.rmSync(outputPath);
      expect(
        finalizeBuildAllStepCache(alwaysRestoreStep, restorable, { rootDir, reusedCache: true }),
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
      const cacheState = resolveBuildAllStepCacheState(refreshStep, { rootDir });
      writeBuildAllStepCacheStamp(refreshStep, cacheState, { rootDir });
      const restorable = resolveBuildAllStepCacheState(refreshStep, { rootDir });
      expect(restoreBuildAllStepCacheOutputs(restorable, { rootDir })).toBe(true);

      fs.writeFileSync(outputPath, "validated refresh");
      expect(
        finalizeBuildAllStepCache(refreshStep, restorable, { rootDir, reusedCache: true }),
      ).toBe(true);
      fs.rmSync(outputPath);

      const refreshed = resolveBuildAllStepCacheState(refreshStep, { rootDir });
      expect(restoreBuildAllStepCacheOutputs(refreshed, { rootDir })).toBe(true);
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

      const cacheState = resolveBuildAllStepCacheState(flatOnlyStep, { rootDir });
      expect(cacheState.relativeOutputFiles).toEqual(["dist/output.d.ts"]);
    });
  });
});
