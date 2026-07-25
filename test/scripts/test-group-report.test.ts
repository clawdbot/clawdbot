// Test Group Report tests cover test group report script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildGroupedTestComparison,
  buildGroupedTestReport,
  renderGroupedTestComparison,
  resolveGroupKey,
  resolveTestArea,
} from "../../scripts/lib/test-group-report.mjs";
import { resolveWindowsTaskkillPath } from "../../scripts/lib/windows-taskkill.mjs";
import {
  parseTestGroupReportArgs,
  resolveFullSuiteVitestEnv,
  resolveReportArtifactDirs,
  resolveReportRunSpecs,
  resolveReportVitestArgs,
  resolveRunPlanConcurrency,
  resolveRunPlans,
  runReportPlans,
  signalTestGroupReportChild,
  spawnText,
} from "../../scripts/test-group-report.mjs";
import { withEnv } from "../../src/test-utils/env.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-group-report-"));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timed out waiting for pid ${pid} to exit`);
}

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child did not close before timeout"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function writeGroupedReport(filePath: string) {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      command: "test-group-report",
      groupBy: "area",
      totals: { durationMs: 100, fileCount: 1, testCount: 1 },
      groups: [
        {
          configs: ["unit-fast"],
          durationMs: 100,
          fileCount: 1,
          key: "test/scripts",
          testCount: 1,
        },
      ],
      configs: [
        {
          configs: ["unit-fast"],
          durationMs: 100,
          fileCount: 1,
          key: "unit-fast",
          testCount: 1,
        },
      ],
      topFiles: [
        {
          config: "unit-fast",
          durationMs: 100,
          file: "test/scripts/test-group-report.test.ts",
          group: "test/scripts",
          testCount: 1,
        },
      ],
      slowTests: [],
      runs: [],
    })}\n`,
    "utf8",
  );
}

describe("scripts/test-group-report grouping", () => {
  it("groups repo files by stable product area", () => {
    expect(resolveTestArea("extensions/discord/src/send.test.ts")).toBe("extensions/discord");
    expect(resolveTestArea("src/commands/agent.test.ts")).toBe("src/commands");
    expect(resolveTestArea("packages/plugin-sdk/src/index.test.ts")).toBe("packages/plugin-sdk");
    expect(resolveTestArea("ui/src/ui/views/chat.test.ts")).toBe("ui/views");
    expect(resolveTestArea("test/scripts/test-group-report.test.ts")).toBe("test/scripts");
  });

  it("supports folder and top-level grouping modes", () => {
    expect(resolveGroupKey("src/commands/agent.test.ts", "folder")).toBe("src/commands");
    expect(resolveGroupKey("extensions/browser/src/browser/pw.test.ts", "folder")).toBe(
      "extensions/browser/src",
    );
    expect(resolveGroupKey("extensions/browser/src/browser/pw.test.ts", "top")).toBe("extensions");
  });
});

describe("scripts/test-group-report aggregation", () => {
  it("aggregates file durations by group and config", () => {
    const report = buildGroupedTestReport({
      groupBy: "area",
      reports: [
        {
          config: "test/vitest/vitest.commands.config.ts",
          report: {
            testResults: [
              {
                name: path.join(process.cwd(), "src", "commands", "agent.test.ts"),
                startTime: 100,
                endTime: 700,
                assertionResults: [
                  { duration: 150, fullName: "agent ok", status: "passed" },
                  { duration: 2600, fullName: "agent slow", status: "passed" },
                ],
              },
              {
                name: path.join(process.cwd(), "extensions", "discord", "src", "send.test.ts"),
                startTime: 200,
                endTime: 450,
                assertionResults: [{ duration: 50, fullName: "send ok", status: "passed" }],
              },
            ],
          },
        },
      ],
      maxTestMs: 2000,
    });

    expect(report.totals).toEqual({ durationMs: 850, fileCount: 2, testCount: 3 });
    expect(report.groups.map((group) => [group.key, group.durationMs])).toEqual([
      ["src/commands", 600],
      ["extensions/discord", 250],
    ]);
    expect(report.configs).toStrictEqual([
      {
        configs: ["commands"],
        key: "commands",
        durationMs: 850,
        fileCount: 2,
        testCount: 3,
      },
    ]);
    expect(report.slowTests).toStrictEqual([
      {
        config: "commands",
        durationMs: 2600,
        file: "src/commands/agent.test.ts",
        fullName: "agent slow",
        status: "passed",
      },
    ]);
  });

  it("fails missing report inputs instead of writing an empty green report", () => {
    const tempDir = makeTempDir();
    const missingReport = path.join(tempDir, "missing.json");
    const output = path.join(tempDir, "group-report.json");
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/test-group-report.mjs", "--report", missingReport, "--output", output],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`[test-group-report] missing JSON report for missing`);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing testResults array", {}],
    ["empty testResults array", { testResults: [] }],
  ])("fails malformed report inputs with %s", (reason, payload) => {
    const tempDir = makeTempDir();
    const reportPath = path.join(tempDir, "malformed.json");
    const output = path.join(tempDir, "group-report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(payload)}\n`, "utf8");
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/test-group-report.mjs", "--report", reportPath, "--output", output],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[test-group-report] invalid JSON report for malformed");
      expect(result.stderr).toContain(reason);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when every allow-failures run produces no JSON report", () => {
    const tempDir = makeTempDir();
    const missingConfig = path.join(tempDir, "missing-vitest.config.ts");
    const output = path.join(tempDir, "group-report.json");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/test-group-report.mjs",
          "--config",
          missingConfig,
          "--allow-failures",
          "--no-rss",
          "--timeout-ms",
          "5000",
          "--output",
          output,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[test-group-report] missing JSON report for failed config");
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("continues allow-failures profiling after a config exits without JSON", async () => {
    const tempDir = makeTempDir();
    const reportDir = path.join(tempDir, "reports");
    const calls: string[] = [];
    try {
      const result = await runReportPlans({
        args: parseTestGroupReportArgs([
          "--config",
          "failed.config.ts",
          "--config",
          "passed.config.ts",
          "--allow-failures",
          "--no-rss",
        ]),
        logDir: path.join(tempDir, "logs"),
        reportDir,
        runPlans: [
          { config: "failed.config.ts", forwardedArgs: [], label: "failed" },
          { config: "passed.config.ts", forwardedArgs: [], label: "passed" },
        ],
        runVitestJsonReport: async (params: {
          config: string;
          label: string;
          logPath: string;
          reportPath: string;
        }) => {
          calls.push(params.label);
          if (params.label === "passed") {
            fs.mkdirSync(path.dirname(params.reportPath), { recursive: true });
            fs.writeFileSync(
              params.reportPath,
              `${JSON.stringify({ testResults: [{ name: "passed.test.ts" }] })}\n`,
              "utf8",
            );
          }
          return {
            config: params.config,
            elapsedMs: 10,
            label: params.label,
            logPath: params.logPath,
            maxRssBytes: null,
            reportPath: params.reportPath,
            status: params.label === "failed" ? 1 : 0,
          };
        },
      });

      expect(calls).toStrictEqual(["failed", "passed"]);
      expect(result.failed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.runs.map((run) => [run.label, run.status])).toStrictEqual([
        ["failed", 1],
        ["passed", 0],
      ]);
      expect(result.runEntries.map((entry) => entry.config)).toStrictEqual(["passed"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("continues allow-failures profiling after a config writes an empty JSON report", async () => {
    const tempDir = makeTempDir();
    try {
      const result = await runReportPlans({
        args: parseTestGroupReportArgs([
          "--config",
          "failed.config.ts",
          "--config",
          "passed.config.ts",
          "--allow-failures",
          "--no-rss",
        ]),
        logDir: path.join(tempDir, "logs"),
        reportDir: path.join(tempDir, "reports"),
        runPlans: [
          { config: "failed.config.ts", forwardedArgs: [], label: "failed" },
          { config: "passed.config.ts", forwardedArgs: [], label: "passed" },
        ],
        runVitestJsonReport: async (params: {
          config: string;
          label: string;
          logPath: string;
          reportPath: string;
        }) => {
          fs.mkdirSync(path.dirname(params.reportPath), { recursive: true });
          fs.writeFileSync(
            params.reportPath,
            `${JSON.stringify({
              testResults: params.label === "failed" ? [] : [{ name: "passed.test.ts" }],
            })}\n`,
            "utf8",
          );
          return {
            config: params.config,
            elapsedMs: 10,
            label: params.label,
            logPath: params.logPath,
            maxRssBytes: null,
            reportPath: params.reportPath,
            status: params.label === "failed" ? 1 : 0,
          };
        },
      });

      expect(result.failed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.runs.map((run) => [run.label, run.status])).toStrictEqual([
        ["failed", 1],
        ["passed", 0],
      ]);
      expect(result.runEntries.map((entry) => entry.config)).toStrictEqual(["passed"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stops admitting report plans after a parallel failure", async () => {
    const tempDir = makeTempDir();
    const labels = ["first", "second", "third"];
    const started: string[] = [];
    const resolvers = new Map<string, (status: number) => void>();
    try {
      const runPromise = runReportPlans({
        args: parseTestGroupReportArgs([
          ...labels.flatMap((label) => ["--config", `${label}.config.ts`]),
          "--concurrency",
          "2",
          "--no-rss",
        ]),
        logDir: path.join(tempDir, "logs"),
        reportDir: path.join(tempDir, "reports"),
        runPlans: labels.map((label) => ({
          config: `${label}.config.ts`,
          forwardedArgs: [],
          label,
        })),
        runVitestJsonReport: async (params: {
          config: string;
          label: string;
          logPath: string;
          reportPath: string;
        }) => {
          started.push(params.label);
          const status = await new Promise<number>((resolve) => {
            resolvers.set(params.label, resolve);
          });
          return {
            config: params.config,
            elapsedMs: 10,
            label: params.label,
            logPath: params.logPath,
            maxRssBytes: null,
            reportPath: params.reportPath,
            status,
          };
        },
      });

      await vi.waitFor(() => {
        expect(started).toStrictEqual(["first", "second"]);
      });
      resolvers.get("first")?.(1);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(started).toStrictEqual(["first", "second"]);
      resolvers.get("second")?.(0);

      const result = await runPromise;
      expect(result.exitCode).toBe(1);
      expect(result.failed).toBe(true);
      expect(result.runs.map((run) => run.label)).toStrictEqual(["first", "second"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prints slow tests as soon as each config report completes", async () => {
    const tempDir = makeTempDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runReportPlans({
        args: parseTestGroupReportArgs([
          "--config",
          "slow.config.ts",
          "--max-test-ms",
          "1000",
          "--no-rss",
        ]),
        logDir: path.join(tempDir, "logs"),
        reportDir: path.join(tempDir, "reports"),
        runPlans: [{ config: "slow.config.ts", forwardedArgs: [], label: "slow" }],
        runVitestJsonReport: async (params: {
          config: string;
          label: string;
          logPath: string;
          reportPath: string;
        }) => {
          fs.mkdirSync(path.dirname(params.reportPath), { recursive: true });
          fs.writeFileSync(
            params.reportPath,
            `${JSON.stringify({
              testResults: [
                {
                  name: path.join(process.cwd(), "src", "slow.test.ts"),
                  assertionResults: [
                    { duration: 1250, fullName: "finishes eventually", status: "passed" },
                  ],
                },
              ],
            })}\n`,
            "utf8",
          );
          return {
            config: params.config,
            elapsedMs: 10,
            label: params.label,
            logPath: params.logPath,
            maxRssBytes: null,
            reportPath: params.reportPath,
            status: 0,
          };
        },
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "slow-test config=slow duration=1250.0ms file=src/slow.test.ts name=finishes eventually",
        ),
      );
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("scripts/test-group-report comparison", () => {
  it("compares grouped reports by group, file, config, and run metrics", () => {
    const comparison = buildGroupedTestComparison({
      beforePath: "before.json",
      afterPath: "after.json",
      before: {
        groupBy: "area",
        totals: { durationMs: 1000, fileCount: 2, testCount: 4 },
        groups: [
          { key: "src/commands", durationMs: 700, fileCount: 1, testCount: 2 },
          { key: "extensions/discord", durationMs: 300, fileCount: 1, testCount: 2 },
        ],
        configs: [{ key: "commands", durationMs: 1000, fileCount: 2, testCount: 4 }],
        topFiles: [
          {
            config: "commands",
            file: "src/commands/agent.test.ts",
            group: "src/commands",
            durationMs: 700,
            testCount: 2,
          },
          {
            config: "commands",
            file: "extensions/discord/src/send.test.ts",
            group: "extensions/discord",
            durationMs: 300,
            testCount: 2,
          },
        ],
        runs: [
          {
            config: "test/vitest/vitest.commands.config.ts",
            elapsedMs: 2000,
            maxRssBytes: 1024 * 1024 * 100,
            status: 0,
          },
        ],
      },
      after: {
        groupBy: "area",
        totals: { durationMs: 900, fileCount: 2, testCount: 5 },
        groups: [{ key: "src/commands", durationMs: 900, fileCount: 2, testCount: 5 }],
        configs: [{ key: "commands", durationMs: 900, fileCount: 2, testCount: 5 }],
        topFiles: [
          {
            config: "commands",
            file: "src/commands/agent.test.ts",
            group: "src/commands",
            durationMs: 800,
            testCount: 3,
          },
          {
            config: "commands",
            file: "src/commands/new.test.ts",
            group: "src/commands",
            durationMs: 100,
            testCount: 2,
          },
        ],
        runs: [
          {
            config: "test/vitest/vitest.commands.config.ts",
            elapsedMs: 1800,
            maxRssBytes: 1024 * 1024 * 80,
            status: 0,
          },
        ],
      },
    });

    expect(comparison.totals.delta).toEqual({ durationMs: -100, fileCount: 0, testCount: 1 });
    const commandsGroup = comparison.groups.find((group) => group.key === "src/commands");
    expect(commandsGroup?.delta).toStrictEqual({ durationMs: 200, fileCount: 1, testCount: 3 });
    const removedDiscordFile = comparison.files.find(
      (file) => file.file === "extensions/discord/src/send.test.ts",
    );
    expect(removedDiscordFile?.status).toBe("removed");
    expect(removedDiscordFile?.delta).toStrictEqual({ durationMs: -300, testCount: -2 });
    expect(comparison.runs[0]?.key).toBe("commands");
    expect(comparison.runs[0]?.delta).toStrictEqual({
      elapsedMs: -200,
      maxRssBytes: -1024 * 1024 * 20,
    });

    expect(renderGroupedTestComparison(comparison, { limit: 2, topFiles: 2 })).toContain(
      "Top group regressions",
    );
  });

  it("keeps sharded run labels distinct in comparisons", () => {
    const comparison = buildGroupedTestComparison({
      before: {
        groupBy: "area",
        totals: { durationMs: 0, fileCount: 0, testCount: 0 },
        groups: [],
        configs: [],
        topFiles: [],
        runs: [
          {
            config: "test/vitest/vitest.gateway-server.config.ts",
            label: "gateway-server-1",
            elapsedMs: 100,
            status: 0,
          },
          {
            config: "test/vitest/vitest.gateway-server.config.ts",
            label: "gateway-server-2",
            elapsedMs: 200,
            status: 0,
          },
        ],
      },
      after: {
        groupBy: "area",
        totals: { durationMs: 0, fileCount: 0, testCount: 0 },
        groups: [],
        configs: [],
        topFiles: [],
        runs: [
          {
            config: "test/vitest/vitest.gateway-server.config.ts",
            label: "gateway-server-1",
            elapsedMs: 110,
            status: 0,
          },
          {
            config: "test/vitest/vitest.gateway-server.config.ts",
            label: "gateway-server-2",
            elapsedMs: 220,
            status: 0,
          },
        ],
      },
    });

    expect(comparison.runs.map((run) => run.key).toSorted()).toEqual([
      "gateway-server-1",
      "gateway-server-2",
    ]);
  });

  it("fails compare mode for malformed grouped reports", () => {
    const tempDir = makeTempDir();
    const beforePath = path.join(tempDir, "before.json");
    const afterPath = path.join(tempDir, "after.json");
    const output = path.join(tempDir, "compare.json");
    fs.writeFileSync(beforePath, "{}\n", "utf8");
    writeGroupedReport(afterPath);
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/test-group-report.mjs", "--compare", beforePath, afterPath, "--output", output],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[test-group-report] invalid grouped report");
      expect(result.stderr).toContain("command must be test-group-report");
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails compare mode for empty grouped report evidence", () => {
    const tempDir = makeTempDir();
    const beforePath = path.join(tempDir, "before.json");
    const afterPath = path.join(tempDir, "after.json");
    const output = path.join(tempDir, "compare.json");
    const emptyReport = {
      command: "test-group-report",
      groupBy: "area",
      totals: { durationMs: 0, fileCount: 0, testCount: 0 },
      groups: [],
      configs: [],
      topFiles: [],
      slowTests: [],
      runs: [],
    };
    fs.writeFileSync(beforePath, `${JSON.stringify(emptyReport)}\n`, "utf8");
    writeGroupedReport(afterPath);
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/test-group-report.mjs", "--compare", beforePath, afterPath, "--output", output],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no evidence rows");
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("scripts/test-group-report arg parsing", () => {
  it("parses repeatable config and passthrough args", () => {
    expect(
      parseTestGroupReportArgs([
        "--config",
        "a.ts",
        "--config",
        "b.ts",
        "--group-by",
        "folder",
        "--allow-failures",
        "--",
        "--maxWorkers=1",
      ]),
    ).toStrictEqual({
      allowFailures: true,
      compare: null,
      concurrency: null,
      configs: ["a.ts", "b.ts"],
      fullSuite: false,
      groupBy: "folder",
      killGraceMs: 10000,
      limit: 25,
      maxTestMs: null,
      output: null,
      reports: [],
      rss: process.platform !== "win32",
      timeoutMs: 1800000,
      topFiles: 25,
      vitestArgs: ["--maxWorkers=1"],
    });
  });

  it("parses compare mode", () => {
    expect(
      parseTestGroupReportArgs([
        "--compare",
        "before.json",
        "after.json",
        "--limit",
        "5",
        "--top-files",
        "3",
      ]),
    ).toStrictEqual({
      allowFailures: false,
      compare: { before: "before.json", after: "after.json" },
      concurrency: null,
      configs: [],
      fullSuite: false,
      groupBy: "area",
      killGraceMs: 10000,
      limit: 5,
      maxTestMs: null,
      output: null,
      reports: [],
      rss: process.platform !== "win32",
      timeoutMs: 1800000,
      topFiles: 3,
      vitestArgs: [],
    });
  });

  it("parses individual test duration threshold", () => {
    expect(parseTestGroupReportArgs(["--max-test-ms", "2000"])).toMatchObject({
      maxTestMs: 2000,
    });
  });

  it("parses explicit run concurrency", () => {
    expect(parseTestGroupReportArgs(["--concurrency", "4"])).toMatchObject({
      concurrency: 4,
    });
  });

  it("parses per-config timeout controls", () => {
    expect(
      parseTestGroupReportArgs(["--timeout-ms", "5000", "--kill-grace-ms", "250"]),
    ).toMatchObject({
      killGraceMs: 250,
      timeoutMs: 5000,
    });
  });

  it("rejects malformed positive integer flags", () => {
    for (const flag of [
      "--limit",
      "--top-files",
      "--max-test-ms",
      "--timeout-ms",
      "--kill-grace-ms",
      "--concurrency",
    ]) {
      expect(() => parseTestGroupReportArgs([flag, "20x"])).toThrow(
        `${flag} must be a positive integer`,
      );
      expect(() => parseTestGroupReportArgs([flag, "0"])).toThrow(
        `${flag} must be a positive integer`,
      );
    }
  });

  it("rejects missing report path, config, and numeric option values", () => {
    for (const flag of ["--config", "--report", "--group-by", "--output"]) {
      expect(() => parseTestGroupReportArgs([flag, "--limit", "5"])).toThrow(
        `${flag} requires a value`,
      );
      expect(() => parseTestGroupReportArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
    }
    for (const flag of [
      "--limit",
      "--top-files",
      "--max-test-ms",
      "--timeout-ms",
      "--kill-grace-ms",
      "--concurrency",
    ]) {
      expect(() => parseTestGroupReportArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseTestGroupReportArgs([flag, "--output", "report.json"])).toThrow(
        `${flag} requires a value`,
      );
    }
    expect(() => parseTestGroupReportArgs(["--compare", "before.json", "--limit"])).toThrow(
      "--compare requires a value",
    );
    expect(() => parseTestGroupReportArgs(["--compare", "--limit", "5"])).toThrow(
      "--compare requires a value",
    );
  });

  it("rejects duplicate single-value report controls", () => {
    for (const [flag, values] of [
      ["--compare", ["before-a.json", "after-a.json", "before-b.json", "after-b.json"]],
      ["--group-by", ["area", "folder"]],
      ["--output", ["first.json", "second.json"]],
      ["--limit", ["5", "10"]],
      ["--top-files", ["5", "10"]],
      ["--max-test-ms", ["100", "200"]],
      ["--timeout-ms", ["1000", "2000"]],
      ["--kill-grace-ms", ["100", "200"]],
      ["--concurrency", ["2", "3"]],
    ] as const) {
      const args =
        flag === "--compare"
          ? [
              flag,
              expectDefined(values[0], "first compare report path"),
              expectDefined(values[1], "first compare baseline path"),
              flag,
              expectDefined(values[2], "second compare report path"),
              expectDefined(values[3], "second compare baseline path"),
            ]
          : [
              flag,
              expectDefined(values[0], `first ${flag} value`),
              flag,
              expectDefined(values[1], `second ${flag} value`),
            ];
      expect(() => parseTestGroupReportArgs(args)).toThrow(
        `${String(flag)} was provided more than once`,
      );
    }
    expect(parseTestGroupReportArgs(["--config", "a.ts", "--config", "b.ts"]).configs).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(parseTestGroupReportArgs(["--report", "a.json", "--report", "b.json"]).reports).toEqual([
      "a.json",
      "b.json",
    ]);
  });
});

describe("scripts/test-group-report child process guard", () => {
  it("signals Windows child process trees with taskkill", () => {
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    signalTestGroupReportChild(child, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );

    signalTestGroupReportChild(child, "SIGKILL", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("force-kills Windows child process trees when graceful taskkill fails", () => {
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    signalTestGroupReportChild(child, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });

    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.concurrent("times out a child that ignores SIGTERM", async () => {
    if (process.platform === "win32") {
      return;
    }

    const started = Date.now();
    const result = await spawnText(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        killGraceMs: 25,
        timeoutMs: 250,
      },
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({
      status: 1,
      signal: "SIGKILL",
      timedOut: true,
    });
    expect(result.output).toContain("command timed out after 250ms");
    expect(result.output).toContain("sending SIGKILL");
  });

  it.concurrent("kills timed wrapper process groups without orphaning the measured process", async () => {
    if (process.platform === "win32" || !fs.existsSync("/usr/bin/time")) {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-group-report-"));
    const markerPath = path.join(tempDir, "marker.txt");
    try {
      const result = await spawnText(
        "/usr/bin/time",
        [
          process.execPath,
          "--input-type=module",
          "--eval",
          [
            "import fs from 'node:fs';",
            "process.on('SIGTERM', () => {});",
            `setInterval(() => fs.appendFileSync(${JSON.stringify(markerPath)}, "x"), 5);`,
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          killGraceMs: 25,
          timeoutMs: 250,
        },
      );

      expect(result).toMatchObject({
        status: 1,
        timedOut: true,
      });
      expect(result.output).toContain("command timed out after 250ms");
      expect(result.output).toContain("sending SIGKILL");

      const sizeAfterReturn = fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0;
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
      const sizeAfterWait = fs.existsSync(markerPath) ? fs.statSync(markerPath).size : 0;
      expect(sizeAfterWait).toBe(sizeAfterReturn);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the wrapper alive while timed process-group descendants await SIGKILL", () => {
    if (process.platform === "win32" || !fs.existsSync("/usr/bin/time")) {
      return;
    }

    const tempDir = makeTempDir();
    const childPidPath = path.join(tempDir, "child.pid");
    const reportModuleUrl = pathToFileURL(path.resolve("scripts/test-group-report.mjs")).href;
    let childPid: number | undefined;
    try {
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "process.on('SIGHUP', () => {});",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const runnerScript = [
        `import { spawnText } from ${JSON.stringify(reportModuleUrl)};`,
        "const result = await spawnText(",
        '  "/usr/bin/time",',
        `  [process.execPath, "--eval", ${JSON.stringify(childScript)}],`,
        "  { cwd: process.cwd(), env: process.env, killGraceMs: 25, timeoutMs: 500 },",
        ");",
        "process.stdout.write(JSON.stringify(result));",
      ].join("\n");
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", runnerScript], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 5_000,
      });
      if (fs.existsSync(childPidPath)) {
        childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
      }

      expect(result.status).toBe(0);
      expect(result.stdout).not.toBe("");
      const parsed = JSON.parse(result.stdout) as Awaited<ReturnType<typeof spawnText>>;
      expect(parsed).toMatchObject({
        status: 1,
        timedOut: true,
      });
      expect(parsed.output).toContain("sending SIGKILL");
    } finally {
      if (childPid !== undefined && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.concurrent("cleans process-group descendants before forwarding parent SIGTERM", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = makeTempDir();
    const childPidPath = path.join(tempDir, "child.pid");
    const readyPath = path.join(tempDir, "child.ready");
    const reportModuleUrl = pathToFileURL(path.resolve("scripts/test-group-report.mjs")).href;
    let childPid: number | undefined;
    let runner: ReturnType<typeof spawn> | undefined;
    try {
      // Publish the pid via rename so it appears atomically: waitForFile polls
      // existence only, and a direct writeFileSync leaves an empty-file window
      // that made the pid parse as NaN (isProcessAlive false) on loaded CI.
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(`${childPidPath}.tmp`)}, String(process.pid));`,
        `fs.renameSync(${JSON.stringify(`${childPidPath}.tmp`)}, ${JSON.stringify(childPidPath)});`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ["--eval", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
        `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const runnerScript = [
        `import { spawnText } from ${JSON.stringify(reportModuleUrl)};`,
        "await spawnText(",
        "  process.execPath,",
        `  ["--eval", ${JSON.stringify(parentScript)}],`,
        "  { cwd: process.cwd(), env: process.env, killGraceMs: 5_000, timeoutMs: 60_000 },",
        ");",
      ].join("\n");

      runner = spawn(process.execPath, ["--input-type=module", "--eval", runnerScript], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      // Generous poll deadlines: spawning the nested runner/parent/child node
      // chain can take multiple seconds on loaded CI runners.
      await waitForFile(readyPath, 10_000);
      await waitForFile(childPidPath, 10_000);
      childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
      expect(isProcessAlive(childPid)).toBe(true);

      runner.kill("SIGTERM");

      await expect(waitForChildClose(runner)).resolves.toEqual({
        code: null,
        signal: "SIGTERM",
      });
      await waitForDead(childPid, 10_000);
    } finally {
      if (runner?.pid && isProcessAlive(runner.pid)) {
        runner.kill("SIGKILL");
      }
      if (childPid !== undefined && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.concurrent("finishes promptly when timed process-group descendants exit cleanly", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = makeTempDir();
    const childPidPath = path.join(tempDir, "child.pid");
    const readyPath = path.join(tempDir, "child.ready");
    const cleanupPath = path.join(tempDir, "child.cleanup");
    let childPid: number | undefined;
    try {
      const childScript = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        `    fs.writeFileSync(${JSON.stringify(cleanupPath)}, "clean");`,
        "    process.exit(0);",
        "  }, 25);",
        "});",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ["--eval", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const startedAt = Date.now();
      const runPromise = spawnText(process.execPath, ["--eval", parentScript], {
        cwd: process.cwd(),
        env: process.env,
        killGraceMs: 250,
        timeoutMs: 250,
      });

      await waitForFile(readyPath, 2_000);
      childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
      const result = await runPromise;

      expect(result).toMatchObject({
        status: 1,
        signal: null,
        timedOut: true,
      });
      expect(fs.readFileSync(cleanupPath, "utf8")).toBe("clean");
      expect(Date.now() - startedAt).toBeLessThan(900);
      await waitForDead(childPid, 2_000);
    } finally {
      if (childPid !== undefined && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.concurrent("streams large child output to a log path without retaining it", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-group-report-log-"));
    const logPath = path.join(tempDir, "child.log");
    try {
      const result = await spawnText(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            "const chunk = Buffer.alloc(1024 * 1024, 120);",
            "for (let index = 0; index < 65; index += 1) process.stdout.write(chunk);",
            'process.stderr.write("Maximum resident set size (kbytes): 12345\\n");',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          killGraceMs: 50,
          logPath,
          outputTailBytes: 4096,
          timeoutMs: 10_000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.output.length).toBeLessThan(8 * 1024);
      expect(result.output).toContain("Maximum resident set size (kbytes): 12345");
      expect(fs.statSync(logPath).size).toBeGreaterThan(64 * 1024 * 1024);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.concurrent("keeps no-log child output bounded to a tail", async () => {
    const result = await spawnText(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          "const chunk = Buffer.alloc(1024 * 1024, 120);",
          "for (let index = 0; index < 3; index += 1) process.stdout.write(chunk);",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        killGraceMs: 50,
        maxBufferBytes: 1024 * 1024,
        outputTailBytes: 4096,
        timeoutMs: 10_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.output.length).toBeLessThan(8 * 1024);
    expect(result.output).toContain("output exceeded 1048576 bytes");
  });

  it.concurrent("stops streamed child output after the configured log cap", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-group-report-log-cap-"));
    const logPath = path.join(tempDir, "child.log");
    try {
      const result = await spawnText(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            "process.on('SIGTERM', () => {});",
            "const chunk = Buffer.alloc(1024 * 1024, 120);",
            "setInterval(() => process.stdout.write(chunk), 1);",
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          killGraceMs: 50,
          logPath,
          maxLogBytes: 1024 * 1024,
          outputTailBytes: 4096,
          timeoutMs: 10_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.signal).toBe("SIGKILL");
      expect(result.output).toContain("output log exceeded 1048576 bytes");
      expect(fs.statSync(logPath).size).toBeLessThan(2 * 1024 * 1024);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("scripts/test-group-report run plans", () => {
  let serialFullSuitePlans: ReturnType<typeof resolveRunPlans> = [];
  let parallelFullSuitePlans: ReturnType<typeof resolveRunPlans> = [];

  beforeAll(() => {
    withEnv(
      {
        OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
        OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: undefined,
      },
      () => {
        serialFullSuitePlans = resolveRunPlans(parseTestGroupReportArgs(["--full-suite"]));
      },
    );
    withEnv({ OPENCLAW_TEST_PROJECTS_PARALLEL: "6" }, () => {
      parallelFullSuitePlans = resolveRunPlans(parseTestGroupReportArgs(["--full-suite"]));
    });
  });

  it("isolates full-suite duration reports by default", () => {
    expect(resolveReportVitestArgs(parseTestGroupReportArgs(["--full-suite"]))).toEqual([
      "--isolate=true",
    ]);
    expect(
      resolveReportVitestArgs(parseTestGroupReportArgs(["--full-suite", "--", "--maxWorkers=1"])),
    ).toEqual(["--maxWorkers=1", "--isolate=true"]);
  });

  it("preserves explicit full-suite isolation choices and explicit-config defaults", () => {
    expect(
      resolveReportVitestArgs(parseTestGroupReportArgs(["--full-suite", "--", "--no-isolate"])),
    ).toEqual(["--no-isolate"]);
    expect(
      resolveReportVitestArgs(parseTestGroupReportArgs(["--full-suite", "--", "--isolate=false"])),
    ).toEqual(["--isolate=false"]);
    expect(resolveReportVitestArgs(parseTestGroupReportArgs(["--config", "a.ts"]))).toEqual([]);
  });

  it("caps Vitest workers for full-suite profiling by default", () => {
    expect(resolveFullSuiteVitestEnv(parseTestGroupReportArgs(["--full-suite"]), {})).toEqual({
      OPENCLAW_VITEST_MAX_WORKERS: "2",
    });
  });

  it("uses a serial worker budget for commands full-suite profiling", () => {
    expect(
      resolveFullSuiteVitestEnv(parseTestGroupReportArgs(["--full-suite"]), {}, "commands"),
    ).toEqual({
      OPENCLAW_VITEST_MAX_WORKERS: "1",
    });
  });

  it("preserves explicit Vitest worker budgets for full-suite profiling", () => {
    expect(
      resolveFullSuiteVitestEnv(parseTestGroupReportArgs(["--full-suite"]), {
        OPENCLAW_VITEST_MAX_WORKERS: "2",
      }),
    ).toEqual({});
    expect(
      resolveFullSuiteVitestEnv(parseTestGroupReportArgs(["--full-suite"]), {
        OPENCLAW_TEST_WORKERS: "2",
      }),
    ).toEqual({});
  });

  it("parallelizes repeated explicit configs but keeps full-suite profiling serial by default", () => {
    expect(
      resolveRunPlanConcurrency(parseTestGroupReportArgs(["--config", "a", "--config", "b"]), 2),
    ).toBe(2);
    expect(resolveRunPlanConcurrency(parseTestGroupReportArgs(["--full-suite"]), 8)).toBe(1);
    expect(
      resolveRunPlanConcurrency(
        parseTestGroupReportArgs(["--full-suite", "--concurrency", "3"]),
        8,
      ),
    ).toBe(3);
    expect(resolveRunPlanConcurrency(parseTestGroupReportArgs(["--concurrency", "9"]), 2)).toBe(2);
  });

  it("isolates Vitest filesystem module caches for parallel report configs", () => {
    const args = parseTestGroupReportArgs(["--config", "a.ts", "--config", "b.ts"]);
    const specs = resolveReportRunSpecs(
      args,
      [
        { config: "a.ts", forwardedArgs: [], label: "a" },
        { config: "b.ts", forwardedArgs: [], label: "b" },
      ],
      { cwd: "/repo", env: {} },
    );

    expect(specs.map((spec) => spec.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH)).toEqual([
      path.join("/repo", "node_modules", ".experimental-vitest-cache", "0-a.ts"),
      path.join("/repo", "node_modules", ".experimental-vitest-cache", "1-b.ts"),
    ]);
    expect(specs.map((spec) => spec.vitestArgs)).toEqual([[], []]);
  });

  it("uses leaf configs for full-suite profiling without requiring parallel env", () => {
    expect(serialFullSuitePlans.map((plan) => plan.config)).not.toContain(
      "test/vitest/vitest.full-agentic.config.ts",
    );
    expect(serialFullSuitePlans.map((plan) => plan.config)).toContain(
      "test/vitest/vitest.agents-tools.config.ts",
    );
  });

  it("preserves full-suite shard file args and unique report labels", () => {
    const gatewayServerPlans = parallelFullSuitePlans.filter(
      (plan) => plan.config === "test/vitest/vitest.gateway-server.config.ts",
    );

    expect(gatewayServerPlans.length).toBeGreaterThan(1);
    expect(new Set(gatewayServerPlans.map((plan) => plan.label)).size).toBe(
      gatewayServerPlans.length,
    );
    expect(gatewayServerPlans.every((plan) => plan.forwardedArgs.length > 0)).toBe(true);
    expect(gatewayServerPlans.flatMap((plan) => plan.forwardedArgs)).toContain(
      "src/gateway/server.node-pairing-authz.test.ts",
    );
  });
});

describe("scripts/test-group-report artifact paths", () => {
  it("keeps raw Vitest reports scoped to the output file stem", () => {
    expect(resolveReportArtifactDirs(".artifacts/test-perf/baseline-before.json")).toEqual({
      reportDir: path.join(".artifacts", "test-perf", "baseline-before", "vitest-json"),
      logDir: path.join(".artifacts", "test-perf", "baseline-before", "logs"),
    });
  });
});
