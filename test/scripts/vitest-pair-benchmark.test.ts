import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeBenchmark,
  assertEquivalentInventories,
  assertExecutionDigest,
  assertInventoryAvailable,
  assertSingleWorkflowAttempt,
  buildBenchmarkCommandEnv,
  buildBenchmarkSchedule,
  loadBenchmarkManifest,
  parseVitestExecutionReport,
  resolvePackageManagerIdentity,
  runOwnedCommand,
  validateBenchmarkManifest,
  VITEST_PAIR_HARNESS_DEADLINE_MS,
  withVitestPairDeadline,
  withTerminalManifest,
  writeJsonAtomic,
  type BenchmarkManifest,
  type BenchmarkRunRecord,
} from "../../scripts/lib/vitest-pair-benchmark.mts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { waitForDead, waitForFile } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const packageManager = {
  executable: "/opt/vitest-pair/pnpm",
  resolvedExecutable: "/opt/vitest-pair/pnpm",
  version: "12.1.0",
};

const manifest: BenchmarkManifest = {
  version: 1,
  rounds: 7,
  thresholds: {
    overallWallRatio: 1.05,
    criticalLaneWallRatio: 1.1,
    criticalLaneWallDeltaMs: 1000,
    improvementRatio: 0.95,
    improvementPairCount: 5,
  },
  lanes: [
    { id: "core", critical: true, config: "test/core.config.ts", files: ["src/core.test.ts"] },
    {
      id: "gateway",
      critical: true,
      config: "test/gateway.config.ts",
      files: ["src/gateway.test.ts"],
    },
    { id: "ui", critical: true, config: "test/ui.config.ts", files: ["ui/view.test.ts"] },
    {
      id: "lifecycle",
      critical: true,
      files: ["test/scripts/lifecycle.test.ts"],
    },
  ],
};

const execution = {
  digest: "a".repeat(64),
  fileCount: 1,
  assertionCount: 1,
  counts: {
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
  },
  success: true as const,
};

type BenchmarkDurations = {
  baselineMs: number;
  candidateMs: number;
};

function recordsFor(
  durations:
    | number
    | BenchmarkDurations
    | ((lane: string, round: number | null) => BenchmarkDurations),
): BenchmarkRunRecord[] {
  const durationsFor =
    typeof durations === "function"
      ? durations
      : typeof durations === "number"
        ? () => ({ baselineMs: 100, candidateMs: 100 * durations })
        : () => durations;
  const records: BenchmarkRunRecord[] = [];
  for (const lane of manifest.lanes) {
    for (let round = 1; round <= manifest.rounds; round += 1) {
      const pair = `measured-${round}-${lane.id}`;
      const pairDurations = durationsFor(lane.id, round);
      for (const side of ["baseline", "candidate"] as const) {
        records.push({
          id: `${pair}-${side}`,
          phase: "measured",
          side,
          lane: lane.id,
          round,
          pair,
          cacheMode: "warm",
          command: ["node"],
          packageManager,
          startedAt: "2026-09-05T00:00:00.000Z",
          durationMs: side === "baseline" ? pairDurations.baselineMs : pairDurations.candidateMs,
          userCpuMs: 50,
          systemCpuMs: 10,
          execution,
          exitCode: 0,
        });
      }
    }
    const coldDurations = durationsFor(lane.id, null);
    for (const side of ["baseline", "candidate"] as const) {
      records.push({
        id: `cold-${lane.id}-${side}`,
        phase: "cold",
        side,
        lane: lane.id,
        round: null,
        pair: `cold-${lane.id}`,
        cacheMode: "fresh",
        command: ["node"],
        packageManager,
        startedAt: "2026-09-05T00:00:00.000Z",
        durationMs: side === "baseline" ? coldDurations.baselineMs : coldDurations.candidateMs,
        userCpuMs: 50,
        systemCpuMs: 10,
        execution,
        exitCode: 0,
      });
    }
  }
  return records;
}

function inventoryPaths(lane: BenchmarkManifest["lanes"][number]): string[] {
  return [...(lane.config ? [lane.config] : []), ...lane.files];
}

function gatewayRegressionDurations(lane: string): BenchmarkDurations {
  return lane === "gateway"
    ? { baselineMs: 10_000, candidateMs: 13_000 }
    : { baselineMs: 10_000, candidateMs: 10_000 };
}

function writeExecutable(file: string, contents: string): void {
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

type ReportAssertion = {
  fullName: string;
  status: "passed" | "skipped";
  location?: unknown;
};
type ReportFile = { path: string; assertions: ReportAssertion[] };

function writeSelectedFiles(root: string, files: string[]): void {
  for (const relative of files) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${relative}\n`);
  }
}

function writeVitestReport(
  reportFile: string,
  root: string,
  files: ReportFile[],
  success = true,
): void {
  const assertions = files.flatMap((file) => file.assertions);
  const passed = assertions.filter((assertion) => assertion.status === "passed").length;
  const pending = assertions.filter((assertion) => assertion.status === "skipped").length;
  writeFileSync(
    reportFile,
    JSON.stringify({
      numTotalTestSuites: files.length,
      numPassedTestSuites: success ? files.length : 0,
      numFailedTestSuites: success ? 0 : files.length,
      numPendingTestSuites: 0,
      numTotalTests: assertions.length,
      numPassedTests: success ? passed : 0,
      numFailedTests: success ? 0 : assertions.length,
      numPendingTests: success ? pending : 0,
      numTodoTests: 0,
      success,
      testResults: files.map((file) => ({
        name: path.join(root, file.path),
        status: success ? "passed" : "failed",
        assertionResults: file.assertions.map((assertion, index) => ({
          ...assertion,
          location: Object.hasOwn(assertion, "location")
            ? assertion.location
            : { line: index + 1, column: 1 },
        })),
      })),
    }),
  );
}

describe("Vitest pair benchmark contract", () => {
  it("keeps the committed representative inventory valid and available", () => {
    const committed = loadBenchmarkManifest("scripts/vitest-pair-benchmark-lanes.json");
    expect(committed.lanes.map((lane) => lane.id)).toStrictEqual([
      "core-unit",
      "gateway-core",
      "ui-jsdom",
      "worker-lifecycle",
    ]);
    expect(assertInventoryAvailable(process.cwd(), committed).inventorySha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("rejects malformed and duplicate inventories", () => {
    expect(() => validateBenchmarkManifest({ ...manifest, rounds: 6 })).toThrow(
      "exactly seven measured rounds",
    );
    expect(() =>
      validateBenchmarkManifest({
        ...manifest,
        lanes: [...manifest.lanes, manifest.lanes[0]],
      }),
    ).toThrow("duplicate benchmark lane id");
    expect(() =>
      validateBenchmarkManifest({
        ...manifest,
        lanes: [{ ...manifest.lanes[0], files: ["../escape.test.ts"] }, ...manifest.lanes.slice(1)],
      }),
    ).toThrow("normalized repository-relative path");
  });

  it("requires every committed inventory path on both sides", () => {
    const root = tempDirs.make("vitest-pair-inventory-");
    for (const lane of manifest.lanes) {
      for (const relative of inventoryPaths(lane)) {
        const file = path.join(root, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${relative}\n`);
      }
    }
    const inventory = assertInventoryAvailable(root, manifest);
    expect(inventory.entries).toHaveLength(7);
    expect(inventory.inventorySha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects selected workload byte mismatches between sides", () => {
    const baselineRoot = tempDirs.make("vitest-pair-baseline-inventory-");
    const candidateRoot = tempDirs.make("vitest-pair-candidate-inventory-");
    for (const lane of manifest.lanes) {
      for (const relative of inventoryPaths(lane)) {
        for (const root of [baselineRoot, candidateRoot]) {
          const file = path.join(root, relative);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, `${relative}\n`);
        }
      }
    }
    writeFileSync(path.join(candidateRoot, manifest.lanes[0]!.files[0]!), "changed workload\n");

    expect(() =>
      assertEquivalentInventories(
        assertInventoryAvailable(baselineRoot, manifest),
        assertInventoryAvailable(candidateRoot, manifest),
      ),
    ).toThrow("benchmark workload bytes differ");
  });

  it("requires successful JSON execution reports with the exact selected file set", () => {
    const root = tempDirs.make("vitest-pair-report-files-");
    const lane = {
      id: "report-files",
      critical: true,
      files: ["src/first.test.ts", "src/second.test.ts"],
    };
    writeSelectedFiles(root, lane.files);
    const reportFile = path.join(root, "report.json");
    writeVitestReport(reportFile, root, [
      {
        path: lane.files[0]!,
        assertions: [{ fullName: "first test", status: "passed" }],
      },
    ]);

    expect(() => parseVitestExecutionReport(reportFile, root, lane)).toThrow(
      "executed files differ",
    );

    writeVitestReport(
      reportFile,
      root,
      lane.files.map((file) => ({
        path: file,
        assertions: [{ fullName: `${file} test`, status: "passed" }],
      })),
      false,
    );
    expect(() => parseVitestExecutionReport(reportFile, root, lane)).toThrow(
      "did not report success",
    );
  });

  it("uses source locations instead of version-specific rendered names", () => {
    const root = tempDirs.make("vitest-pair-report-digest-");
    const lane = {
      id: "report-digest",
      critical: true,
      files: ["src/example.test.ts"],
    };
    writeSelectedFiles(root, lane.files);
    const baselineFile = path.join(root, "baseline.json");
    writeVitestReport(baselineFile, root, [
      {
        path: lane.files[0]!,
        assertions: [
          {
            fullName: "mime detection maps 'avif' image format",
            status: "passed",
            location: { line: 62, column: 5 },
          },
          {
            fullName: "mime detection maps 'jpg' image format",
            status: "passed",
            location: { line: 62, column: 5 },
          },
          {
            fullName: "mime detection 'detects docx from buffer'",
            status: "passed",
            location: { line: 79, column: 14 },
          },
        ],
      },
    ]);
    const baseline = parseVitestExecutionReport(baselineFile, root, lane);
    const candidateFile = path.join(root, "candidate.json");
    writeVitestReport(candidateFile, root, [
      {
        path: lane.files[0]!,
        assertions: [
          {
            fullName: "mime detection maps avif image format",
            status: "passed",
            location: { line: 62, column: 5 },
          },
          {
            fullName: "mime detection maps jpg image format",
            status: "passed",
            location: { line: 62, column: 5 },
          },
          {
            fullName: "mime detection detects docx from buffer",
            status: "passed",
            location: { line: 79, column: 14 },
          },
        ],
      },
    ]);
    const candidate = parseVitestExecutionReport(candidateFile, root, lane);

    expect(candidate.digest).toBe(baseline.digest);
    expect(candidate.assertionCount).toBe(3);
  });

  it("fails closed when assertion locations are missing or malformed", () => {
    const root = tempDirs.make("vitest-pair-report-location-");
    const lane = {
      id: "report-location",
      critical: true,
      files: ["src/example.test.ts"],
    };
    writeSelectedFiles(root, lane.files);

    for (const [label, location] of [
      ["missing", undefined],
      ["zero", { line: 0, column: 5 }],
      ["fractional", { line: 62, column: 5.5 }],
      ["string", { line: 62, column: "5" }],
    ] as const) {
      const candidateFile = path.join(root, `candidate-${label}.json`);
      writeVitestReport(candidateFile, root, [
        {
          path: lane.files[0]!,
          assertions: [{ fullName: "suite stable test", status: "passed", location }],
        },
      ]);
      expect(() => parseVitestExecutionReport(candidateFile, root, lane)).toThrow(
        "location must contain positive integer line and column",
      );
    }
  });

  it("fails closed when assertion status or source location diverges", () => {
    const root = tempDirs.make("vitest-pair-report-divergence-");
    const lane = {
      id: "report-divergence",
      critical: true,
      files: ["src/example.test.ts"],
    };
    writeSelectedFiles(root, lane.files);
    const baselineFile = path.join(root, "baseline.json");
    writeVitestReport(baselineFile, root, [
      {
        path: lane.files[0]!,
        assertions: [
          {
            fullName: "suite stable test",
            status: "passed",
            location: { line: 62, column: 5 },
          },
        ],
      },
    ]);
    const baseline = parseVitestExecutionReport(baselineFile, root, lane);

    for (const [label, assertion] of [
      [
        "status",
        {
          fullName: "suite stable test",
          status: "skipped" as const,
          location: { line: 62, column: 5 },
        },
      ],
      [
        "location",
        {
          fullName: "suite stable test",
          status: "passed" as const,
          location: { line: 63, column: 5 },
        },
      ],
    ] as const) {
      const candidateFile = path.join(root, `candidate-${label}.json`);
      writeVitestReport(candidateFile, root, [{ path: lane.files[0]!, assertions: [assertion] }]);
      const candidate = parseVitestExecutionReport(candidateFile, root, lane);
      expect(() =>
        assertExecutionDigest(candidate, baseline.digest, `${label} timing run`),
      ).toThrow("execution digest differs");
    }
  });

  it("rotates lane order and alternates paired side order", () => {
    const schedule = buildBenchmarkSchedule(manifest);
    const measured = schedule.filter((entry) => entry.phase === "measured");
    expect(measured.slice(0, 8).map((entry) => `${entry.lane.id}:${entry.side}`)).toStrictEqual([
      "core:baseline",
      "core:candidate",
      "gateway:baseline",
      "gateway:candidate",
      "ui:baseline",
      "ui:candidate",
      "lifecycle:baseline",
      "lifecycle:candidate",
    ]);
    expect(measured.slice(8, 16).map((entry) => `${entry.lane.id}:${entry.side}`)).toStrictEqual([
      "gateway:candidate",
      "gateway:baseline",
      "ui:candidate",
      "ui:baseline",
      "lifecycle:candidate",
      "lifecycle:baseline",
      "core:candidate",
      "core:baseline",
    ]);
    expect(schedule.filter((entry) => entry.phase === "warmup")).toHaveLength(8);
    expect(schedule.filter((entry) => entry.phase === "cold")).toHaveLength(8);
  });

  it("refuses reruns before a benchmark child can start", () => {
    expect(() => assertSingleWorkflowAttempt("1")).not.toThrow();
    expect(() => assertSingleWorkflowAttempt("2")).toThrow("dispatch a fresh run");
  });

  it("fails critical regressions and avoids noisy improvement claims", () => {
    const regression = analyzeBenchmark(recordsFor(gatewayRegressionDurations), manifest);
    expect(regression.verdict).toBe("regression");
    expect(regression.regressions).toStrictEqual(
      expect.arrayContaining([expect.stringContaining("gateway median paired wall ratio")]),
    );

    const neutral = analyzeBenchmark(recordsFor(0.98), manifest);
    expect(neutral.verdict).toBe("pass");
    expect(neutral.performance).toBe("no-material-change");
    expect(neutral.claim).toContain("No broad improvement claim");

    const improved = analyzeBenchmark(recordsFor(0.9), manifest);
    expect(improved.verdict).toBe("pass");
    expect(improved.performance).toBe("improved");

    const noisyFaster = analyzeBenchmark(
      recordsFor((_lane, round) => ({
        baselineMs: 100,
        candidateMs: 100 * (round !== null && round <= 4 ? 0.9 : 0.999),
      })),
      manifest,
    );
    expect(noisyFaster.verdict).toBe("pass");
    expect(noisyFaster.performance).toBe("no-material-change");
    expect(noisyFaster.lanes.every((lane) => lane.candidateImprovedPairs === 4)).toBe(true);
  });

  it("weights aggregate acceptance by duration for each measured round", () => {
    const analysis = analyzeBenchmark(
      recordsFor((lane) =>
        lane === "gateway"
          ? { baselineMs: 10_000, candidateMs: 10_600 }
          : { baselineMs: 100, candidateMs: 90 },
      ),
      manifest,
    );

    expect(analysis.overall.measuredWallRatio).toBeCloseTo(10_870 / 10_300);
    expect(analysis.verdict).toBe("regression");
    expect(analysis.regressions[0]).toContain("overall median duration-weighted");
  });

  it("accepts the exact aggregate boundary and rejects values above it", () => {
    expect(
      analyzeBenchmark(recordsFor({ baselineMs: 1000, candidateMs: 1050 }), manifest).verdict,
    ).toBe("pass");
    expect(
      analyzeBenchmark(recordsFor({ baselineMs: 1000, candidateMs: 1050.1 }), manifest).verdict,
    ).toBe("regression");
  });

  it.each([
    {
      name: "ratio only",
      baselineMs: 5000,
      candidateMs: 5600,
      regression: false,
    },
    {
      name: "delta only",
      baselineMs: 20_000,
      candidateMs: 21_000,
      regression: false,
    },
    {
      name: "exact ratio boundary",
      baselineMs: 10_000,
      candidateMs: 11_000,
      regression: false,
    },
    {
      name: "exact delta boundary",
      baselineMs: 5000,
      candidateMs: 6000,
      regression: true,
    },
    {
      name: "ratio and delta above thresholds",
      baselineMs: 10_000,
      candidateMs: 11_200,
      regression: true,
    },
  ])("applies both critical lane thresholds: $name", ({ baselineMs, candidateMs, regression }) => {
    const analysis = analyzeBenchmark(
      recordsFor((lane) => ({
        baselineMs,
        candidateMs: lane === "gateway" ? candidateMs : baselineMs,
      })),
      manifest,
    );
    const gateway = analysis.lanes.find((lane) => lane.id === "gateway");

    expect(gateway?.regressions).toHaveLength(regression ? 1 : 0);
    expect(analysis.verdict).toBe(regression ? "regression" : "pass");
  });

  it("keeps cold timing diagnostic and records measured lane deltas", () => {
    const analysis = analyzeBenchmark(
      recordsFor((_lane, round) =>
        round === null
          ? { baselineMs: 100, candidateMs: 1000 }
          : { baselineMs: 10_000, candidateMs: 10_500 },
      ),
      manifest,
    );

    expect(analysis.verdict).toBe("pass");
    expect(analysis.regressions).toEqual([]);
    expect(analysis.overall.coldWallRatio).toBe(10);
    expect(analysis.lanes.every((lane) => lane.coldWallRatio === 10)).toBe(true);
    expect(analysis.lanes.every((lane) => lane.measuredWallDeltaMs === 500)).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "pins pnpm despite poisoned ambient pnpm and Corepack state",
    () => {
      const root = tempDirs.make("vitest-pair-pnpm-");
      const bin = path.join(root, "bin");
      const marker = path.join(root, "invocations.txt");
      const pinnedDir = path.join(root, "pinned");
      mkdirSync(bin);
      mkdirSync(pinnedDir);
      for (const name of ["pnpm", "corepack"]) {
        writeExecutable(
          path.join(bin, name),
          `#!/bin/sh\nprintf 'poison:${name}\\n' >> ${JSON.stringify(marker)}\nexit 97\n`,
        );
      }
      const pinned = path.join(pinnedDir, "pnpm");
      writeExecutable(
        pinned,
        `#!/bin/sh\nprintf 'pinned\\n' >> ${JSON.stringify(marker)}\nprintf '12.1.0\\n'\n`,
      );
      const ambientEnv = {
        ...process.env,
        COREPACK_HOME: path.join(root, "poison-corepack"),
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        npm_execpath: path.join(bin, "pnpm"),
      };
      const identity = resolvePackageManagerIdentity(pinned, path.join(root, "probe"), ambientEnv);
      const cacheRoot = path.join(root, "run-cache");
      const env = buildBenchmarkCommandEnv(
        path.join(root, "home"),
        cacheRoot,
        identity,
        ambientEnv,
      );
      const runner = resolvePnpmRunner({ env, pnpmArgs: ["--version"] });
      const result = spawnSync(runner.command, runner.args, {
        encoding: "utf8",
        env,
        shell: runner.shell,
        windowsVerbatimArguments: runner.windowsVerbatimArguments,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("12.1.0");
      expect(identity).toStrictEqual({
        executable: pinned,
        resolvedExecutable: pinned,
        version: "12.1.0",
      });
      expect(env.npm_execpath).toBe(pinned);
      expect(env.COREPACK_HOME).toBe(path.join(cacheRoot, "corepack"));
      expect(readFileSync(marker, "utf8")).toBe("pinned\npinned\n");
    },
  );
});

describe("Vitest pair benchmark lifecycle", () => {
  it("persists terminal failure and atomically replaces JSON state", async () => {
    const root = tempDirs.make("vitest-pair-terminal-");
    const state = path.join(root, "state.json");
    writeJsonAtomic(state, { generation: 1 });
    writeJsonAtomic(state, { generation: 2 });
    expect(JSON.parse(readFileSync(state, "utf8"))).toStrictEqual({ generation: 2 });

    await expect(
      withTerminalManifest(root, async () => {
        throw new Error("injected benchmark failure");
      }),
    ).rejects.toThrow("injected benchmark failure");
    expect(
      JSON.parse(readFileSync(path.join(root, "terminal-manifest.json"), "utf8")),
    ).toMatchObject({
      status: "failure",
      error: "injected benchmark failure",
    });
  });

  it.runIf(process.platform !== "win32")(
    "aborts the active child at the aggregate deadline and starts no successor",
    async () => {
      expect(VITEST_PAIR_HARNESS_DEADLINE_MS).toBe(165 * 60 * 1000);
      const root = tempDirs.make("vitest-pair-deadline-");
      const pidFile = path.join(root, "active.pid");
      const successor = path.join(root, "successor.txt");
      const output = path.join(root, "output");
      const activeScript = [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");

      await expect(
        withTerminalManifest(output, async () => {
          await withVitestPairDeadline(async (deadline) => {
            await expect(
              runOwnedCommand({
                bin: process.execPath,
                args: ["-e", activeScript],
                cwd: root,
                env: { PATH: process.env.PATH },
                logPath: path.join(root, "active.log"),
                deadline,
                timeoutMs: 10_000,
              }),
            ).rejects.toThrow("Vitest pair aggregate deadline exceeded");
            await expect(
              runOwnedCommand({
                bin: process.execPath,
                args: [
                  "-e",
                  `require("node:fs").writeFileSync(${JSON.stringify(successor)}, "started")`,
                ],
                cwd: root,
                env: { PATH: process.env.PATH },
                logPath: path.join(root, "successor.log"),
                deadline,
                timeoutMs: 10_000,
              }),
            ).rejects.toThrow("Vitest pair aggregate deadline exceeded");
          }, 500);
        }),
      ).rejects.toThrow("Vitest pair aggregate deadline exceeded");

      await waitForFile(pidFile, 3_000);
      await waitForDead(Number.parseInt(readFileSync(pidFile, "utf8"), 10), 5_000);
      expect(existsSync(successor)).toBe(false);
      expect(
        JSON.parse(readFileSync(path.join(output, "terminal-manifest.json"), "utf8")),
      ).toMatchObject({
        status: "failure",
        error: "Vitest pair aggregate deadline exceeded after 500ms",
      });
    },
  );

  it.runIf(process.platform !== "win32")("does not retry a failed benchmark child", async () => {
    const root = tempDirs.make("vitest-pair-no-retry-");
    const attempts = path.join(root, "attempts.txt");
    const script = [
      'const { appendFileSync } = require("node:fs");',
      `appendFileSync(${JSON.stringify(attempts)}, "attempt\\n");`,
      "process.exit(7);",
    ].join("\n");

    const result = await runOwnedCommand({
      bin: process.execPath,
      args: ["-e", script],
      cwd: root,
      env: { PATH: process.env.PATH },
      logPath: path.join(root, "output.log"),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(7);
    expect(readFileSync(attempts, "utf8")).toBe("attempt\n");
  });

  it.runIf(process.platform !== "win32")(
    "fails closed and cleans a leaked descendant process",
    async () => {
      const root = tempDirs.make("vitest-pair-leak-");
      const pidFile = path.join(root, "child.pid");
      const script = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "child.unref();",
      ].join("\n");

      await expect(
        runOwnedCommand({
          bin: process.execPath,
          args: ["-e", script],
          cwd: root,
          env: { PATH: process.env.PATH },
          logPath: path.join(root, "output.log"),
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow(/process group remained active|cleanup could not verify/u);

      await waitForFile(pidFile, 3_000);
      const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      await waitForDead(pid, 5_000);
    },
  );

  it.runIf(process.platform === "linux")(
    "uses GNU time labels understood by the hosted Linux runner",
    () => {
      const root = tempDirs.make("vitest-pair-gnu-time-");
      const output = path.join(root, "time.txt");
      const result = spawnSync("/usr/bin/time", ["-v", "-o", output, process.execPath, "-e", ""], {
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      const measurements = readFileSync(output, "utf8");
      expect(measurements).toMatch(/^\s*User time \(seconds\):\s+\d+(?:\.\d+)?\s*$/mu);
      expect(measurements).toMatch(/^\s*System time \(seconds\):\s+\d+(?:\.\d+)?\s*$/mu);
    },
  );
});
