import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMarkdown, parseArgs } from "../../scripts/openclaw-performance-source-summary.mjs";

const tmpRoots: string[] = [];

function mkTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-source-summary-"));
  tmpRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/openclaw-performance-source-summary.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

function writeSourceFixture(sourceDir: string) {
  writeJson(path.join(sourceDir, "gateway-cpu", "gateway-startup-bench.json"), {
    results: [
      {
        id: "default",
        name: "default",
        summary: {
          readyzMs: { p50: 12, p95: 18 },
          healthzMs: { p50: 5 },
          httpListenLogMs: { p50: 8 },
          gatewayReadyLogMs: { p50: 9 },
          firstOutputMs: { p50: 30 },
          maxRssMb: { p95: 120 },
          cpuCoreRatio: { p95: 0.25 },
          startupTrace: {
            "memory.ready.heapUsedMb": { p50: 30, p95: 32 },
            "phase.load": { p50: 7, p95: 8 },
          },
        },
      },
    ],
  });
  writeJson(path.join(sourceDir, "gateway-cpu", "summary.json"), {
    observations: [],
  });
  writeJson(path.join(sourceDir, "cli-startup.json"), {
    primary: {
      cases: [
        {
          id: "gatewayHealthJson",
          name: "gateway health json",
          summary: {
            durationMs: { p50: 10, p95: 14 },
            maxRssMb: { p95: 90 },
            exitSummary: "code:0x3",
          },
        },
      ],
    },
  });
  writeJson(path.join(sourceDir, "extension-memory.json"), {
    topByDeltaMb: [
      { dir: "extensions/browser", maxRssMb: 80, deltaFromBaselineMb: 12, status: "ok" },
    ],
  });
  writeJson(path.join(sourceDir, "sqlite-perf-smoke.json"), {
    integrity: { agent: ["ok"], state: "ok" },
    profile: "smoke",
    queries: [{ p50Ms: 0.1, p95Ms: 0.2, query: "SELECT 1", rows: 1 }],
    rows: {
      agentCacheEntries: 1000,
      agentDatabases: 2,
      channelIngressEvents: 1000,
      cronJobs: 100,
      cronTaskRuns: 1000,
      deliveryQueueEntries: 1000,
      pluginStateEntries: 1000,
      stateRows: 4100,
    },
    timingsMs: { checkpoint: 1, seed: 100, total: 150 },
    walBytes: { agentAfter: [0], agentBefore: [1024], stateAfter: 0, stateBefore: 4096 },
  });
  writeJson(path.join(sourceDir, "mock-hello", "run-001", "qa-suite-summary.json"), {
    counts: { failed: 0, passed: 1, total: 1 },
    metrics: {
      gatewayCpuCoreRatio: 0.15,
      gatewayProcessRssDeltaBytes: 1024 * 1024,
      gatewayProcessRssEndBytes: 91 * 1024 * 1024,
      gatewayProcessRssStartBytes: 90 * 1024 * 1024,
      wallMs: 250,
    },
    run: { primaryModel: "mock-openai/perf" },
    scenarios: [{ id: "mock-hello", status: "pass" }],
  });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("parseArgs", () => {
  it("parses source summary paths", () => {
    expect(
      parseArgs([
        "--source-dir",
        "reports/current",
        "--baseline-source-dir",
        "reports/baseline",
        "--output",
        "summary.md",
      ]),
    ).toEqual({
      sourceDir: path.resolve("reports/current"),
      baselineSourceDir: path.resolve("reports/baseline"),
      output: path.resolve("summary.md"),
    });
  });

  it("rejects missing path values", () => {
    for (const flag of ["--source-dir", "--baseline-source-dir", "--output"]) {
      expect(() => parseArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, ""])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "--source-dir", "reports/current"])).toThrow(
        `${flag} requires a value`,
      );
    }
  });

  it("reports CLI argument errors without a Node stack trace", () => {
    const missingSource = runCli();
    expect(missingSource.status).toBe(1);
    expect(missingSource.stdout).toBe("");
    expect(missingSource.stderr.trim()).toBe("--source-dir is required");
    expectNoNodeStack(missingSource.stderr);

    const unknownArg = runCli("--wat");
    expect(unknownArg.status).toBe(1);
    expect(unknownArg.stdout).toBe("");
    expect(unknownArg.stderr.trim()).toBe("Unknown argument: --wat");
    expectNoNodeStack(unknownArg.stderr);
  });
});

describe("buildMarkdown", () => {
  it("renders source performance fixtures with required artifacts", () => {
    const sourceDir = mkTmpRoot();
    writeSourceFixture(sourceDir);

    expect(buildMarkdown(sourceDir, null)).toContain("run-001");
    expect(buildMarkdown(sourceDir, null)).toContain("gateway health json");
    expect(buildMarkdown(sourceDir, null)).toContain("## SQLite State Smoke");
    expect(buildMarkdown(sourceDir, null)).toContain("4100");
  });

  it("rejects a missing source directory", () => {
    expect(() => buildMarkdown(path.join(mkTmpRoot(), "missing"), null)).toThrow(
      "[source-performance] missing required source dir:",
    );
  });

  it("rejects missing source performance artifacts", () => {
    const sourceDir = mkTmpRoot();

    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      "[source-performance] missing required gateway startup artifact:",
    );
  });

  it("rejects malformed mock hello summaries", () => {
    const sourceDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    writeJson(path.join(sourceDir, "mock-hello", "run-001", "qa-suite-summary.json"), {});

    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      "[source-performance] invalid mock hello summary counts:",
    );
  });

  it("rejects mock hello summaries without matching scenario evidence", () => {
    const sourceDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    writeJson(path.join(sourceDir, "mock-hello", "run-001", "qa-suite-summary.json"), {
      counts: { failed: 0, passed: 1, total: 1 },
      metrics: {
        gatewayCpuCoreRatio: 0.15,
        gatewayProcessRssDeltaBytes: 1024 * 1024,
        gatewayProcessRssEndBytes: 91 * 1024 * 1024,
        gatewayProcessRssStartBytes: 90 * 1024 * 1024,
        wallMs: 250,
      },
      run: { primaryModel: "mock-openai/perf" },
      scenarios: [{ id: "mock-hello", status: "fail" }],
    });

    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      "[source-performance] invalid mock hello scenario evidence:",
    );
  });

  it("rejects gateway startup artifacts without resource metrics", () => {
    const sourceDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    writeJson(path.join(sourceDir, "gateway-cpu", "gateway-startup-bench.json"), {
      results: [{ id: "default", summary: { readyzMs: { p50: 12 } } }],
    });

    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      "[source-performance] incomplete gateway startup metrics for default:",
    );
  });

  it("allows source performance fixtures without older-ref SQLite smoke artifacts", () => {
    const sourceDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    fs.rmSync(path.join(sourceDir, "sqlite-perf-smoke.json"));

    expect(buildMarkdown(sourceDir, null)).toContain("## SQLite State Smoke");
    expect(buildMarkdown(sourceDir, null)).toContain("No data.");
  });

  it("rejects malformed SQLite perf smoke artifacts", () => {
    const sourceDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    writeJson(path.join(sourceDir, "sqlite-perf-smoke.json"), {
      integrity: { agent: ["ok"], state: "ok" },
      profile: "smoke",
      rows: { stateRows: 4100 },
      walBytes: { stateAfter: 1 },
    });

    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      "[source-performance] incomplete SQLite perf metrics:",
    );
  });

  it("rejects SQLite perf smoke artifacts with failing agent integrity", () => {
    const sourceDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    writeJson(path.join(sourceDir, "sqlite-perf-smoke.json"), {
      integrity: { agent: ["ok", "database disk image is malformed"], state: "ok" },
      profile: "smoke",
      queries: [{ p50Ms: 0.1, p95Ms: 0.2, query: "SELECT 1", rows: 1 }],
      rows: { agentCacheEntries: 1000, stateRows: 4100 },
      timingsMs: { total: 150 },
      walBytes: { stateAfter: 0, stateBefore: 4096 },
    });

    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      "[source-performance] SQLite agent integrity check did not pass:",
    );
  });
});
