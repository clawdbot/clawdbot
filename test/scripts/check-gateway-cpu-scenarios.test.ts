// Check Gateway Cpu Scenarios tests cover check gateway cpu scenarios script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/check-gateway-cpu-scenarios.mjs";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const artifactRoot = path.join(process.cwd(), ".artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(path.join(artifactRoot, "gateway-cpu-test-"));
  tempRoots.push(root);
  return root;
}

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/check-gateway-cpu-scenarios.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

function writeQaSuiteSummary(
  outputDir: string,
  counts: { failed: number; passed: number; total: number } = { failed: 0, passed: 1, total: 1 },
): void {
  const qaOutputDir = path.join(outputDir, "qa-suite");
  mkdirSync(qaOutputDir, { recursive: true });
  writeFileSync(
    path.join(qaOutputDir, "qa-suite-summary.json"),
    `${JSON.stringify({
      counts,
      metrics: { gatewayCpuCoreRatio: 0, wallMs: 1 },
      run: { completedAt: "2026-01-01T00:00:01.000Z", startedAt: "2026-01-01T00:00:00.000Z" },
      scenarios: [
        {
          id: "channel-chat-baseline",
          status: counts.failed > 0 ? "fail" : "pass",
          ...(counts.failed > 0 ? {} : { steps: [{ name: "mock step", status: "pass" }] }),
        },
      ],
    })}\n`,
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("gateway CPU scenario guard", () => {
  it("rejects runs with every scenario family skipped", () => {
    expect(() =>
      testing.parseArgs(["--output-dir", makeTempRoot(), "--skip-startup", "--skip-qa"]),
    ).toThrow("--skip-startup and --skip-qa cannot be used together");
  });

  it("accepts package-manager argument separators before script options", () => {
    expect(
      testing.parseArgs([
        "--",
        "--output-dir",
        makeTempRoot(),
        "--startup-case",
        "default",
        "--qa-scenario",
        "channel-chat-baseline",
        "--runs",
        "2",
      ]),
    ).toMatchObject({
      qaScenarios: ["channel-chat-baseline"],
      runs: 2,
      startupCases: ["default"],
    });
  });

  it("rejects non-decimal numeric options", () => {
    expect(() => testing.parseArgs(["--output-dir", makeTempRoot(), "--runs", "1e3"])).toThrow(
      "--runs must be a positive integer",
    );
    expect(() => testing.parseArgs(["--output-dir", makeTempRoot(), "--warmup", "0x10"])).toThrow(
      "--warmup must be a non-negative integer",
    );
    expect(() =>
      testing.parseArgs(["--output-dir", makeTempRoot(), "--cpu-core-warn", "1e3"]),
    ).toThrow("--cpu-core-warn must be a positive number");
  });

  it("rejects missing valued options instead of consuming the next flag", () => {
    for (const flag of [
      "--output-dir",
      "--startup-case",
      "--qa-scenario",
      "--runs",
      "--warmup",
      "--cpu-core-warn",
      "--hot-wall-warn-ms",
    ]) {
      for (const value of ["--skip-qa", "-h"]) {
        expect(() => testing.parseArgs([flag, value])).toThrow(`Missing value for ${flag}`);
      }
    }
  });

  it("rejects duplicate single-value controls before running scenarios", () => {
    expect(() =>
      testing.parseArgs(["--output-dir", makeTempRoot(), "--output-dir", makeTempRoot()]),
    ).toThrow("--output-dir was provided more than once");

    const result = runCli("--runs", "1", "--runs", "2");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--runs was provided more than once");
    expectNoNodeStack(result.stderr);
  });

  it("reports CLI argument errors without a Node stack trace", () => {
    const result = runCli("--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown argument: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("prepares CLI startup artifacts before running the startup bench", async () => {
    type SpawnCall = {
      args: string[];
      command: string;
      env?: Record<string, string | undefined>;
    };
    const outputDir = makeTempRoot();
    const startupOutput = path.join(outputDir, "gateway-startup-bench.json");
    const calls: SpawnCall[] = [];
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--runs",
      "1",
      "--warmup",
      "0",
      "--skip-qa",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "install" },
      silent: true,
      spawnSync: (command: string, args: string[], opts?: { env?: Record<string, string> }) => {
        calls.push({ args, command, env: opts?.env });
        if (args.includes("scripts/bench-gateway-startup.ts")) {
          writeFileSync(startupOutput, `${JSON.stringify({ results: [{ id: "default" }] })}\n`);
        }
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.args[0])).toEqual([
      "scripts/ensure-cli-startup-build.mjs",
      "--import",
    ]);
    expect(calls[1]?.args).toContain("scripts/bench-gateway-startup.ts");
    expect(calls[0]?.env?.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN).toBe("false");
    expect(calls[1]?.env?.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN).toBe("false");
  });

  it("fails successful startup benches that do not write a report", async () => {
    const outputDir = makeTempRoot();
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--runs",
      "1",
      "--warmup",
      "0",
      "--skip-qa",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      silent: true,
      spawnSync: () => ({ status: 0 }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatchObject({
      startupOutput: null,
      startupReportFailure: "startup-report-missing",
    });
    expect(result.summary.startupReportFailureDetail).toContain("expected startup bench report");
  });

  it("fails successful startup benches that write malformed reports", async () => {
    const outputDir = makeTempRoot();
    const startupOutput = path.join(outputDir, "gateway-startup-bench.json");
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--runs",
      "1",
      "--warmup",
      "0",
      "--skip-qa",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      silent: true,
      spawnSync: (_command: string, args: string[]) => {
        if (args.includes("scripts/bench-gateway-startup.ts")) {
          writeFileSync(startupOutput, `${JSON.stringify({ results: [] })}\n`);
        }
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatchObject({
      startupOutput,
      startupReportFailure: "startup-report-invalid",
      startupReportFailureDetail: "startup report has no measured results",
    });
  });

  it("does not run the startup bench when the startup build fails", async () => {
    const outputDir = makeTempRoot();
    const calls: string[][] = [];
    const options = testing.parseArgs(["--output-dir", outputDir, "--skip-qa"]);

    const result = await testing.runGatewayCpuScenarios(options, {
      silent: true,
      spawnSync: (_command: string, args: string[]) => {
        calls.push(args);
        return { status: 1 };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(calls).toEqual([["scripts/ensure-cli-startup-build.mjs"]]);
    expect(result.summary.steps).toEqual([
      { name: "startup build", signal: null, status: 1 },
      { name: "startup bench", signal: null, status: 1 },
    ]);
  });

  it("fails startup build spawn errors and skips the startup bench", async () => {
    const outputDir = makeTempRoot();
    const calls: string[][] = [];
    const options = testing.parseArgs(["--output-dir", outputDir, "--skip-qa"]);

    const result = await testing.runGatewayCpuScenarios(options, {
      silent: true,
      spawnSync: (_command: string, args: string[]) => {
        calls.push(args);
        return {
          error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
          signal: null,
          status: null,
        };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(calls).toEqual([["scripts/ensure-cli-startup-build.mjs"]]);
    expect(result.summary.steps).toEqual([
      { name: "startup build", error: "spawn ENOENT", signal: null, status: 1 },
      { name: "startup bench", signal: null, status: 1 },
    ]);
  });

  it("prebuilds private QA dist before running QA scenarios when it is missing", async () => {
    const cwd = makeTempRoot();
    const outputDir = path.join(cwd, "out");
    const calls: Array<{ args: string[]; env?: Record<string, string | undefined> }> = [];
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--skip-startup",
      "--qa-scenario",
      "channel-chat-baseline",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      cwd,
      env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "install" },
      silent: true,
      spawnSync: (_command: string, args: string[], opts?: { env?: Record<string, string> }) => {
        calls.push({ args, env: opts?.env });
        if (args[0] === "scripts/build-all.mjs") {
          const pluginSdkDist = path.join(cwd, "dist", "plugin-sdk");
          mkdirSync(pluginSdkDist, { recursive: true });
          writeFileSync(path.join(pluginSdkDist, "qa-lab.js"), "export {};\n");
          writeFileSync(path.join(pluginSdkDist, "qa-runtime.js"), "export {};\n");
        }
        if (args.includes("openclaw") && args.includes("qa")) {
          writeQaSuiteSummary(outputDir);
        }
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.steps.map((step) => step.name)).toEqual(["private QA build", "qa suite"]);
    expect(calls[0]?.args).toEqual(["scripts/build-all.mjs", "qaRuntime"]);
    expect(calls[0]?.env).toMatchObject({
      HOME: path.join(outputDir, "qa-state-root", "home"),
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_CONFIG_PATH: path.join(outputDir, "qa-state-root", "state", "openclaw.json"),
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_HOME: path.join(outputDir, "qa-state-root", "home"),
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_STATE_DIR: path.join(outputDir, "qa-state-root", "state"),
      OPENCLAW_TEST_DISABLE_UPDATE_CHECK: "1",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
      USERPROFILE: path.join(outputDir, "qa-state-root", "home"),
    });
    expect(calls[0]?.env?.OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS).toBeUndefined();
  });

  it("does not prebuild private QA dist when the required entries already exist", async () => {
    const cwd = makeTempRoot();
    const outputDir = path.join(cwd, "out");
    const pluginSdkDist = path.join(cwd, "dist", "plugin-sdk");
    mkdirSync(pluginSdkDist, { recursive: true });
    writeFileSync(path.join(pluginSdkDist, "qa-lab.js"), "export {};\n");
    writeFileSync(path.join(pluginSdkDist, "qa-runtime.js"), "export {};\n");
    const calls: Array<{ args: string[]; env?: Record<string, string | undefined> }> = [];
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--skip-startup",
      "--qa-scenario",
      "channel-chat-baseline",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      cwd,
      env: {
        HOME: "/real/user/home",
        OPENCLAW_CONFIG_PATH: "/real/user/.openclaw/openclaw.json",
        OPENCLAW_HOME: "/real/user/home",
        OPENCLAW_STATE_DIR: "/real/user/.openclaw",
      },
      silent: true,
      spawnSync: (_command: string, args: string[], opts?: { env?: Record<string, string> }) => {
        calls.push({ args, env: opts?.env });
        if (args.includes("openclaw") && args.includes("qa")) {
          writeQaSuiteSummary(outputDir);
        }
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.steps.map((step) => step.name)).toEqual(["qa suite"]);
    expect(calls.some((call) => call.args[0] === "scripts/build-all.mjs")).toBe(false);
    expect(calls[0]?.env).toMatchObject({
      HOME: path.join(outputDir, "qa-state-root", "home"),
      OPENCLAW_CONFIG_PATH: path.join(outputDir, "qa-state-root", "state", "openclaw.json"),
      OPENCLAW_HOME: path.join(outputDir, "qa-state-root", "home"),
      OPENCLAW_STATE_DIR: path.join(outputDir, "qa-state-root", "state"),
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
      USERPROFILE: path.join(outputDir, "qa-state-root", "home"),
    });
    expect(calls[0]?.env?.HOME).not.toBe("/real/user/home");
  });

  it("fails successful QA commands that report failed scenarios", async () => {
    const outputDir = makeTempRoot();
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--skip-startup",
      "--qa-scenario",
      "channel-chat-baseline",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      silent: true,
      spawnSync: (_command: string, args: string[]) => {
        if (args.includes("openclaw") && args.includes("qa")) {
          writeQaSuiteSummary(outputDir, { failed: 1, passed: 0, total: 1 });
        }
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatchObject({
      qaSummaryFailure: "qa-summary-failed-scenarios",
      qaSummaryFailureDetail: "QA suite reported 1 failed scenario(s)",
    });
  });

  it("fails when completed runs report hot gateway CPU observations", async () => {
    const outputDir = makeTempRoot();
    const startupOutput = path.join(outputDir, "gateway-startup-bench.json");
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--skip-qa",
      "--cpu-core-warn",
      "0.9",
      "--hot-wall-warn-ms",
      "30000",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      silent: true,
      spawnSync: (_command: string, args: string[]) => {
        if (args.includes("scripts/bench-gateway-startup.ts")) {
          writeFileSync(
            startupOutput,
            `${JSON.stringify({
              results: [
                {
                  id: "default",
                  summary: {
                    cpuCoreRatio: { max: 1.15 },
                    readyzMs: { max: 45_000 },
                  },
                },
              ],
            })}\n`,
          );
        }
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary.observations).toEqual([
      {
        kind: "startup-cpu-hot",
        id: "default",
        cpuCoreRatioMax: 1.15,
        wallMsMax: 45_000,
      },
    ]);
  });
});
