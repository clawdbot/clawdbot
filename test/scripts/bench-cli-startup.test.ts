// Bench Cli Startup tests cover bench cli startup script behavior.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-cli-startup.ts";
import { withEnv } from "../../src/test-utils/env.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("bench-cli-startup", () => {
  it("rejects unknown CLI options before running benchmarks", () => {
    expect(() => testing.validateCliArgs(["--wat"])).toThrow("Unknown argument: --wat");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-cli-startup.ts", "--wat"],
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

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-cli-startup.ts", "--output", "-h"],
      {
        cwd: join(__dirname, "../.."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--output requires a value");
    expect(result.stderr).not.toContain("Node.js");
    expect(result.stderr).not.toContain("\n    at ");
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

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/bench-cli-startup.ts",
        "--output",
        "one.json",
        "--output",
        "two.json",
      ],
      {
        cwd: join(__dirname, "../.."),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--output was provided more than once");
    expect(result.stderr).not.toContain("Node.js");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it.runIf(process.platform !== "win32")(
    "cleans timed-out benchmark process groups when the leader exits first",
    () => {
      const tempDirs = createTempDirTracker();
      const tmpDir = tempDirs.make("openclaw-cli-startup-timeout-group-");
      const entryPath = join(tmpDir, "entry.mjs");
      const childPidPath = join(tmpDir, "child.pid");
      let childPid: number | undefined;
      try {
        writeFileSync(
          entryPath,
          [
            "import { spawn } from 'node:child_process';",
            "import { writeFileSync } from 'node:fs';",
            "process.on('SIGTERM', () => process.exit(0));",
            "const child = spawn(process.execPath, [",
            "  '-e',",
            "  \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\",",
            "], { stdio: 'ignore' });",
            `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
            "setInterval(() => {}, 1000);",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/bench-cli-startup.ts",
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
              OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS: "50",
              VITEST: "1",
            },
            timeout: 8_000,
          },
        );

        childPid = Number(readFileSync(childPidPath, "utf8"));
        expect(result.status).toBe(1);
        expect(result.signal).toBeNull();
        expect(result.stderr).toContain("version sample 1: timed out");
        expect(isProcessAlive(childPid)).toBe(false);
      } finally {
        if (childPid !== undefined && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
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
    const expectedFixture = {
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
      ).toEqual(expectedFixture);
    }
  });

  it("parses config fixture gateway ports strictly from env", () => {
    expect(testing.parseGatewayPortEnv(undefined)).toBe(32123);
    expect(testing.parseGatewayPortEnv("127.0.0.1:45678")).toBe(45678);
    expect(testing.parseGatewayPortEnv("[::1]:45679")).toBe(45679);
    expect(testing.parseGatewayPortEnv("::1")).toBe(32123);
    expect(testing.parseGatewayPortEnv("[::1]")).toBe(32123);

    expect(
      withEnv({ OPENCLAW_GATEWAY_PORT: "45678" }, () =>
        testing.buildConfigFixture({
          id: "gatewayHealthJson",
          name: "gateway health --json",
          args: ["gateway", "health", "--json"],
          presets: ["real"],
        }),
      ),
    ).toMatchObject({ gateway: { port: 45678 } });

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
