// Bench Cli Startup tests cover bench cli startup script behavior.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-cli-startup.ts";
import { forceKillVitestProcessGroup } from "../../scripts/vitest-process-group.mts";
import { withEnv } from "../../src/test-utils/env.js";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";

describe("bench-cli-startup", () => {
  it("rejects unknown CLI options before running benchmarks", () => {
    expect(() => testing.validateCliArgs(["--wat"])).toThrow("Unknown argument: --wat");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-cli-startup.ts", "--wat", "--help"],
      {
        cwd: join(__dirname, "../.."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown argument: --wat");
    expect(result.stderr).not.toContain("Node.js");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("rejects short flag values before running benchmarks", () => {
    expect(() => testing.validateCliArgs(["--output", "-h"])).toThrow("--output requires a value");
    expect(() => testing.validateCliArgs(["--case", "-h"])).toThrow("--case requires a value");
  });

  it("rejects duplicate benchmark cases before running benchmarks", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-cli-startup.ts", "--case", "version", "--case", "version"],
      {
        cwd: join(__dirname, "../.."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe('Duplicate --case "version"');
    expect(result.stderr).not.toContain("Node.js");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("rejects duplicate single-value controls before running benchmarks", () => {
    expect(() => testing.validateCliArgs(["--output", "one.json", "--output", "two.json"])).toThrow(
      "--output was provided more than once",
    );
  });

  it.runIf(process.platform !== "win32")(
    "cleans timed-out benchmark process groups when the leader exits first",
    async () => {
      const tempDirs = createTempDirTracker();
      const tmpDir = tempDirs.make("openclaw-cli-startup-timeout-group-");
      const entryPath = join(tmpDir, "entry.mjs");
      const leaderPidPath = join(tmpDir, "leader.pid");
      const childPidPath = join(tmpDir, "child.pid");
      const childTermPath = join(tmpDir, "child-term.pid");
      try {
        writeFileSync(
          entryPath,
          `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => process.exit(0));
writeFileSync(${JSON.stringify(leaderPidPath)}, String(process.pid));
spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(childTermPath)}, String(process.pid)));
writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`,
          "utf8",
        );

        // Keep real processes, but advance deadlines only after child-owned readiness.
        // The driver isolates Node mock timers from Vitest and the fixture processes.
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
import assert from "node:assert/strict";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isProcessAlive, waitForPidFile } from ${JSON.stringify(new URL("../helpers/process-wait.ts", import.meta.url).href)};
const realDelay = delay;
mock.timers.enable({ apis: ["setTimeout", "Date"] });
try {
  const benchmark = import(pathToFileURL(process.argv[1]).href);
  const leader = await waitForPidFile(${JSON.stringify(leaderPidPath)}, 8000, realDelay);
  const child = await waitForPidFile(${JSON.stringify(childPidPath)}, 8000, realDelay);
  assert(isProcessAlive(leader), "leader must be alive before timeout");
  assert(isProcessAlive(child), "descendant must be ready before timeout");
  mock.timers.tick(100);
  while (isProcessAlive(leader)) await realDelay(5);
  assert.equal(await waitForPidFile(${JSON.stringify(childTermPath)}, 8000, realDelay), child);
  assert(isProcessAlive(child), "descendant must outlive its leader");
  mock.timers.tick(50);
  while (isProcessAlive(child)) await realDelay(5);
  // Drain cleanup waits only after the OS has consumed SIGKILL.
  mock.timers.runAll();
  await benchmark;
} catch (error) {
  console.error(error);
  process.exit(2);
} finally {
  mock.timers.reset();
}
`,
            resolve(__dirname, "../../scripts/bench-cli-startup.ts"),
            "--entry",
            entryPath,
            "--case",
            "version",
            "--runs",
            "1",
            "--warmup",
            "0",
            "--timeout-ms",
            "100",
            "--json",
          ],
          {
            cwd: join(__dirname, "../.."),
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: tmpDir,
              OPENCLAW_STATE_DIR: join(tmpDir, ".openclaw"),
              OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS: "50",
              VITEST: "1",
            },
            timeout: 8_000,
          },
        );

        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(1);
        expect(result.signal).toBeNull();
        expect(result.stderr).toContain("version sample 1: timed out");
        expect(JSON.parse(result.stdout).primary.cases[0].samples).toMatchObject([
          { timedOut: true, exitCode: 0, signal: null },
        ]);
        expect(isProcessAlive(Number(readFileSync(leaderPidPath, "utf8")))).toBe(false);
        expect(isProcessAlive(Number(readFileSync(childPidPath, "utf8")))).toBe(false);
      } finally {
        // The leader registers before spawning: failures before child readiness still
        // leave a known group to kill, including an unregistered descendant.
        if (existsSync(leaderPidPath)) {
          const leader = Number(readFileSync(leaderPidPath, "utf8"));
          forceKillVitestProcessGroup({ pid: leader });
          await waitForDead(leader, 8_000);
        }
        if (existsSync(childPidPath)) {
          await waitForDead(Number(readFileSync(childPidPath, "utf8")), 8_000);
        }
        tempDirs.cleanup();
      }
    },
  );

  it("writes compare-mode JSON output and creates parent directories", () => {
    const tempDirs = createTempDirTracker();
    const tmpDir = tempDirs.make("openclaw-cli-startup-compare-output-");
    try {
      const baselinePath = join(tmpDir, "baseline.json");
      const candidatePath = join(tmpDir, "candidate.json");
      const outputPath = join(tmpDir, "nested", "comparison.json");
      const makeReport = (durationAvg: number, maxRssAvg: number) => ({
        primary: {
          entry: "openclaw.mjs",
          cases: [
            {
              id: "version",
              name: "--version",
              args: ["--version"],
              contract: null,
              samples: [],
              summary: {
                sampleCount: 1,
                durationMs: {
                  avg: durationAvg,
                  p50: durationAvg,
                  p95: durationAvg,
                  min: durationAvg,
                  max: durationAvg,
                },
                firstOutputMs: null,
                maxRssMb: {
                  avg: maxRssAvg,
                  p50: maxRssAvg,
                  p95: maxRssAvg,
                  min: maxRssAvg,
                  max: maxRssAvg,
                },
                exitSummary: "code:0x1",
              },
            },
          ],
        },
      });

      writeFileSync(baselinePath, JSON.stringify(makeReport(100, 50)), "utf8");
      writeFileSync(candidatePath, JSON.stringify(makeReport(125, 60)), "utf8");

      const { comparison } = testing.readBenchmarkComparison(baselinePath, candidatePath);
      testing.writeJsonOutput(outputPath, comparison);
      expect(existsSync(outputPath)).toBe(true);
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
        baseline: baselinePath,
        candidate: candidatePath,
        deltas: [
          {
            id: "version",
            name: "--version",
            durationAvgDeltaMs: 25,
            durationAvgDeltaPct: 25,
            maxRssAvgDeltaMb: 10,
            maxRssAvgDeltaPct: 20,
          },
        ],
      });
    } finally {
      tempDirs.cleanup();
    }
  });

  it("passes generated import hook paths as file URL specifiers", () => {
    const hookPath = resolve("measure-rss.mjs");

    expect(testing.nodeImportSpecifierForPath(hookPath)).toBe(pathToFileURL(hookPath).href);
  });

  it("fails reports with no measured samples", () => {
    expect(
      testing.collectFailedSamples({
        entry: "openclaw.mjs",
        cases: [
          {
            id: "version",
            name: "--version",
            args: ["--version"],
            contract: null,
            samples: [],
            summary: {
              sampleCount: 0,
              durationMs: { avg: 0, p50: 0, p95: 0, min: 0, max: 0 },
              firstOutputMs: null,
              maxRssMb: null,
              exitSummary: "",
            },
          },
        ],
      }),
    ).toEqual(["openclaw.mjs version: no measured samples"]);
  });

  it("fails reports with nonzero or signaled CLI samples", () => {
    const passingSample = {
      ms: 10,
      firstOutputMs: 5,
      maxRssMb: 50,
      exitCode: 0,
      signal: null,
    };

    expect(
      testing.collectFailedSamples({
        entry: "dist/entry.js",
        cases: [
          {
            id: "gatewayStatusJson",
            name: "gateway status --json",
            args: ["gateway", "status", "--json"],
            contract: null,
            samples: [
              passingSample,
              { ...passingSample, exitCode: 1 },
              { ...passingSample, exitCode: null, signal: "SIGTERM" },
              { ...passingSample, timedOut: true },
            ],
            summary: {
              sampleCount: 4,
              durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
              firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
              maxRssMb: { avg: 50, p50: 50, p95: 50, min: 50, max: 50 },
              exitSummary: "code:0x1, code:1x1, signal:SIGTERMx1",
            },
          },
        ],
      }),
    ).toEqual([
      "dist/entry.js gatewayStatusJson sample 2: exited with code 1",
      "dist/entry.js gatewayStatusJson sample 3: exited via signal SIGTERM",
      "dist/entry.js gatewayStatusJson sample 4: timed out",
    ]);
  });

  it("retains and validates warmup samples separately from measured samples", () => {
    const passingSample = {
      ms: 10,
      firstOutputMs: 5,
      maxRssMb: 50,
      exitCode: 0,
      signal: null,
      startedAt: "2026-08-01T20:00:00.000Z",
      endedAt: "2026-08-01T20:00:00.010Z",
    };

    expect(
      testing.collectFailedSamples({
        entry: "dist/entry.js",
        cases: [
          {
            id: "gatewayHealthJsonWarmState",
            name: "gateway health --json (warm state)",
            args: ["gateway", "health", "--json"],
            contract: null,
            warmupSamples: [{ ...passingSample, exitCode: 1 }],
            samples: [passingSample],
            summary: {
              sampleCount: 1,
              durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
              firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
              maxRssMb: { avg: 50, p50: 50, p95: 50, min: 50, max: 50 },
              exitSummary: "code:0x1",
            },
          },
        ],
      }),
    ).toEqual(["dist/entry.js gatewayHealthJsonWarmState warmup 1: exited with code 1"]);
  });

  it("fails reports with samples that did not report RSS", () => {
    expect(
      testing.collectFailedSamples({
        entry: "openclaw.mjs",
        cases: [
          {
            id: "version",
            name: "--version",
            args: ["--version"],
            contract: null,
            samples: [
              {
                ms: 10,
                firstOutputMs: 5,
                maxRssMb: null,
                exitCode: 0,
                signal: null,
              },
            ],
            summary: {
              sampleCount: 1,
              durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
              firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
              maxRssMb: null,
              exitSummary: "code:0x1",
            },
          },
        ],
      }),
    ).toEqual(["openclaw.mjs version sample 1: did not report max RSS"]);
  });

  it("allows declared nonzero exit codes for clean-state probes", () => {
    const sample = {
      ms: 10,
      firstOutputMs: 5,
      maxRssMb: 50,
      exitCode: 1,
      signal: null,
      stderrTail: "Health check failed: gateway closed\n  Gateway target: ws://127.0.0.1:18789",
    };

    expect(
      testing.collectFailedSamples({
        entry: "openclaw.mjs",
        cases: [
          {
            id: "health",
            name: "health",
            args: ["health"],
            expectedExitCodes: [0, 1],
            expectedNonzeroOutputIncludes: ["Gateway target:"],
            contract: null,
            samples: [sample],
            summary: {
              sampleCount: 1,
              durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
              firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
              maxRssMb: { avg: 50, p50: 50, p95: 50, min: 50, max: 50 },
              exitSummary: "code:1x1",
            },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects allowed nonzero exits without their expected clean-state output", () => {
    const sample = {
      ms: 10,
      firstOutputMs: 5,
      maxRssMb: 50,
      exitCode: 1,
      signal: null,
      stderrTail: "TypeError: crashed before output",
    };

    expect(
      testing.collectFailedSamples({
        entry: "openclaw.mjs",
        cases: [
          {
            id: "health",
            name: "health",
            args: ["health"],
            expectedExitCodes: [0, 1],
            expectedNonzeroOutputIncludes: ["Gateway target:"],
            contract: null,
            samples: [sample],
            summary: {
              sampleCount: 1,
              durationMs: { avg: 10, p50: 10, p95: 10, min: 10, max: 10 },
              firstOutputMs: { avg: 5, p50: 5, p95: 5, min: 5, max: 5 },
              maxRssMb: { avg: 50, p50: 50, p95: 50, min: 50, max: 50 },
              exitSummary: "code:1x1",
            },
          },
        ],
      }),
    ).toEqual([
      "openclaw.mjs health sample 1: exited with expected code 1 but output did not match expected clean-state markers (Gateway target:)",
    ]);
  });

  it("rejects invalid measured run counts", () => {
    expect(() => testing.parsePositiveInt("0", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(() => testing.parsePositiveInt("2abc", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(() => testing.parsePositiveInt("1.5", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(() => testing.parsePositiveInt("1e3", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(() => testing.parsePositiveInt("0x10", 5, "--runs")).toThrow(
      "--runs must be an integer >= 1",
    );
    expect(testing.parsePositiveInt("1", 5)).toBe(1);
    expect(testing.parseNonNegativeInt("0", 1)).toBe(0);
    expect(() => testing.parseNonNegativeInt("-1", 1, "--warmup")).toThrow(
      "--warmup must be an integer >= 0",
    );
    expect(() => testing.parseNonNegativeInt("0b10", 1, "--warmup")).toThrow(
      "--warmup must be an integer >= 0",
    );
  });

  it("writes a config fixture for config get benchmarks", () => {
    const unauthenticatedFixture = {
      gateway: {
        auth: { mode: "none" },
        bind: "loopback",
        mode: "local",
        port: 32123,
      },
    };
    for (const commandCase of [
      {
        id: "configGetGatewayPort",
        name: "config get gateway.port",
        args: ["config", "get", "gateway.port"],
        presets: ["real"],
      },
      {
        id: "gatewayHealthJson",
        name: "gateway health --json",
        args: ["gateway", "health", "--json"],
        presets: ["real"],
      },
      { id: "health", name: "health", args: ["health"], presets: ["startup", "real"] },
      {
        id: "healthJson",
        name: "health --json",
        args: ["health", "--json"],
        presets: ["startup"],
      },
    ]) {
      expect(
        withEnv({ OPENCLAW_GATEWAY_PORT: undefined }, () =>
          testing.buildConfigFixture(commandCase),
        ),
      ).toEqual(unauthenticatedFixture);
    }

    for (const commandCase of [
      {
        id: "gatewayHealthJsonWarmState",
        name: "gateway health --json (warm state)",
        args: ["gateway", "health", "--json"],
        presets: [],
      },
      {
        id: "gatewayHealthJsonFreshState",
        name: "gateway health --json (fresh state)",
        args: ["gateway", "health", "--json"],
        presets: [],
      },
    ]) {
      expect(
        withEnv({ OPENCLAW_GATEWAY_PORT: undefined }, () =>
          testing.buildConfigFixture(commandCase),
        ),
      ).toEqual({
        gateway: {
          auth: { mode: "token" },
          bind: "loopback",
          mode: "local",
          port: 32123,
        },
      });
    }
  });

  it("parses config fixture gateway ports strictly from env", () => {
    expect(testing.parseGatewayPortEnv(undefined)).toBe(32123);
    expect(testing.parseGatewayPortEnv("127.0.0.1:45678")).toBe(45678);
    expect(testing.parseGatewayPortEnv("[::1]:45679")).toBe(45679);
    expect(testing.parseGatewayPortEnv("::1")).toBe(32123);
    expect(testing.parseGatewayPortEnv("[::1]")).toBe(32123);

    for (const id of [
      "gatewayHealthJson",
      "gatewayHealthJsonWarmState",
      "gatewayHealthJsonFreshState",
    ]) {
      expect(
        withEnv({ OPENCLAW_GATEWAY_PORT: "45678" }, () =>
          testing.buildConfigFixture({
            id,
            name: "gateway health --json",
            args: ["gateway", "health", "--json"],
            presets: [],
          }),
        ),
      ).toMatchObject({ gateway: { port: 45678 } });
    }

    for (const invalid of ["45678abc", "127.0.0.1:45678abc"]) {
      expect(() =>
        withEnv({ OPENCLAW_GATEWAY_PORT: invalid }, () =>
          testing.buildConfigFixture({
            id: "gatewayHealthJson",
            name: "gateway health --json",
            args: ["gateway", "health", "--json"],
            presets: ["real"],
          }),
        ),
      ).toThrow("OPENCLAW_GATEWAY_PORT must be an integer >= 1");
    }
  });
});
