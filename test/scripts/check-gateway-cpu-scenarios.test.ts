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

  it("prepares CLI startup artifacts before running the startup bench", async () => {
    const outputDir = makeTempRoot();
    const calls: Array<{ command: string; args: string[] }> = [];
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
      spawnSync: (command: string, args: string[]) => {
        calls.push({ command, args });
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.args[0])).toEqual([
      "scripts/ensure-cli-startup-build.mjs",
      "--import",
    ]);
    expect(calls[1]?.args).toContain("scripts/bench-gateway-startup.ts");
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
      silent: true,
      spawnSync: (_command: string, args: string[], opts?: { env?: Record<string, string> }) => {
        calls.push({ args, env: opts?.env });
        if (args[0] === "scripts/build-all.mjs") {
          const pluginSdkDist = path.join(cwd, "dist", "plugin-sdk");
          mkdirSync(pluginSdkDist, { recursive: true });
          writeFileSync(path.join(pluginSdkDist, "qa-lab.js"), "export {};\n");
          writeFileSync(path.join(pluginSdkDist, "qa-runtime.js"), "export {};\n");
        }
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.steps.map((step) => step.name)).toEqual(["private QA build", "qa suite"]);
    expect(calls[0]?.args).toEqual(["scripts/build-all.mjs", "qaRuntime"]);
    expect(calls[0]?.env).toMatchObject({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
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
    const calls: string[][] = [];
    const options = testing.parseArgs([
      "--output-dir",
      outputDir,
      "--skip-startup",
      "--qa-scenario",
      "channel-chat-baseline",
    ]);

    const result = await testing.runGatewayCpuScenarios(options, {
      cwd,
      silent: true,
      spawnSync: (_command: string, args: string[]) => {
        calls.push(args);
        return { status: 0 };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.steps.map((step) => step.name)).toEqual(["qa suite"]);
    expect(calls.some((args) => args[0] === "scripts/build-all.mjs")).toBe(false);
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
