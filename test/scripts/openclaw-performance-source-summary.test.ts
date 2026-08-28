import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMarkdown, parseArgs } from "../../scripts/openclaw-performance-source-summary.mts";

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
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/openclaw-performance-source-summary.mts", ...args],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
    },
  );
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
            "phase.load.total": { p50: 70, p95: 80 },
            "phase.load.itemCount": { p50: 40, p95: 50 },
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
    baseline: { maxRssMb: 50, status: "ok" },
    combined: { maxRssMb: 180, status: "ok" },
    counts: { totalEntries: 12 },
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

function writeSqliteV2Fixture(
  sourceDir: string,
  queries: Array<Record<string, unknown>> = [
    {
      database: "state",
      id: "delivery.pending.load",
      p50Ms: 10,
      p95Ms: 12,
      plan: {
        fullTableScans: [],
        indexes: ["idx_delivery_queue_pending"],
        raw: ["SEARCH delivery_queue_entries USING INDEX idx_delivery_queue_pending"],
        tempSorts: [],
      },
      rows: 1000,
      runs: 12,
      sql: "SELECT id FROM delivery_queue_entries WHERE queue_name = ? AND status = ?",
    },
  ],
) {
  writeJson(path.join(sourceDir, "sqlite-perf-smoke.json"), {
    integrity: { agent: ["ok"], state: "ok" },
    profile: "smoke",
    queries,
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
    schemaVersion: 2,
    timingsMs: { checkpoint: 1, seed: 100, total: 150 },
    versions: { agentSchema: 16, sqlite: "3.53.4", stateSchema: 13 },
    walBytes: { agentAfter: [0], agentBefore: [1024], stateAfter: 0, stateBefore: 4096 },
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
    expect(buildMarkdown(sourceDir, null)).toContain("| default | phase.load | 7.0ms | 8.0ms |");
    expect(buildMarkdown(sourceDir, null)).not.toContain("phase.load.total");
    expect(buildMarkdown(sourceDir, null)).not.toContain("phase.load.itemCount");
    expect(buildMarkdown(sourceDir, null)).not.toContain("memory.ready.heapUsedMb");
    expect(buildMarkdown(sourceDir, null)).toContain(
      "Per-plugin rows are isolated cold imports and are not additive.",
    );
    expect(buildMarkdown(sourceDir, null)).toContain(
      "| all 12 bundled plugins | 180.0MB | 130.0MB | ok |",
    );
    expect(buildMarkdown(sourceDir, null)).toContain("isolated delta from empty process");
  });

  it("compares reordered v2 SQLite scenarios only by shared scenario ID", () => {
    const sourceDir = mkTmpRoot();
    const baselineDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    writeSourceFixture(baselineDir);
    writeSqliteV2Fixture(sourceDir, [
      {
        database: "state",
        id: "delivery.pending.load",
        p50Ms: 10,
        p95Ms: 15,
        plan: {
          fullTableScans: [],
          indexes: ["idx_delivery_queue_pending"],
          raw: ["SEARCH delivery_queue_entries USING INDEX idx_delivery_queue_pending"],
          tempSorts: [],
        },
        rows: 1000,
        runs: 12,
        sql: "SELECT id FROM delivery_queue_entries WHERE status = ?",
      },
      {
        database: "agent",
        id: "agent-cache.plugin-model-catalog.list",
        p50Ms: 1,
        p95Ms: 2,
        plan: {
          fullTableScans: [],
          indexes: ["sqlite_autoindex_cache_entries_1"],
          raw: ["SEARCH cache_entries USING INDEX sqlite_autoindex_cache_entries_1"],
          tempSorts: [],
        },
        rows: 100,
        runs: 12,
        sql: "SELECT key FROM cache_entries WHERE scope = ?",
      },
    ]);
    writeSqliteV2Fixture(baselineDir, [
      {
        database: "agent",
        id: "baseline-only",
        p50Ms: 3,
        p95Ms: 4,
        plan: {
          fullTableScans: [],
          indexes: ["sqlite_autoindex_cache_entries_1"],
          raw: ["SEARCH cache_entries USING INDEX sqlite_autoindex_cache_entries_1"],
          tempSorts: [],
        },
        rows: 100,
        runs: 12,
        sql: "SELECT key FROM cache_entries WHERE scope = ?",
      },
      {
        database: "state",
        id: "delivery.pending.load",
        p50Ms: 18,
        p95Ms: 20,
        plan: {
          fullTableScans: [],
          indexes: ["idx_delivery_queue_pending"],
          raw: ["SEARCH delivery_queue_entries USING INDEX idx_delivery_queue_pending"],
          tempSorts: [],
        },
        rows: 1000,
        runs: 12,
        sql: "SELECT id FROM delivery_queue_entries WHERE status = ?",
      },
    ]);

    const markdown = buildMarkdown(sourceDir, baselineDir);

    expect(markdown).toContain("| current | v2 | smoke | 3.53.4 | 13 | 16 |");
    expect(markdown).toContain(
      "| delivery.pending.load | state | 1000 | 12 | 10.0ms | 15.0ms | 1000 | 12 | 20.0ms | -25.0% |",
    );
    expect(markdown).toContain(
      "| agent-cache.plugin-model-catalog.list | agent | 100 | 12 | 1.0ms | 2.0ms | n/a | n/a | n/a | n/a |",
    );
    expect(markdown).not.toContain("| baseline-only |");
  });

  it("does not compare v2 SQLite scenarios with different workloads", () => {
    for (const baselineQuery of [
      {
        database: "state",
        rows: 999,
        runs: 20,
        sql: "SELECT id FROM delivery_queue_entries WHERE queue_name = ? AND status = ?",
      },
      {
        database: "agent",
        rows: 1000,
        runs: 12,
        sql: "SELECT id FROM delivery_queue_entries WHERE queue_name = ? AND status = ?",
      },
      {
        database: "state",
        rows: 1000,
        runs: 12,
        sql: "SELECT id FROM delivery_queue_entries WHERE status = ?",
      },
    ]) {
      const sourceDir = mkTmpRoot();
      const baselineDir = mkTmpRoot();
      writeSourceFixture(sourceDir);
      writeSourceFixture(baselineDir);
      writeSqliteV2Fixture(sourceDir);
      writeSqliteV2Fixture(baselineDir, [
        {
          ...baselineQuery,
          id: "delivery.pending.load",
          p50Ms: 18,
          p95Ms: 20,
          plan: {
            fullTableScans: [],
            indexes: ["idx_delivery_queue_pending"],
            raw: ["SEARCH delivery_queue_entries USING INDEX idx_delivery_queue_pending"],
            tempSorts: [],
          },
        },
      ]);

      expect(buildMarkdown(sourceDir, baselineDir)).toContain(
        `| delivery.pending.load | state | 1000 | 12 | 10.0ms | 12.0ms | ${baselineQuery.rows} | ${baselineQuery.runs} | 20.0ms | n/a (workload differs) |`,
      );
    }
  });

  it("rejects duplicate and empty v2 SQLite scenario IDs", () => {
    for (const ids of [
      ["delivery.pending.load", "delivery.pending.load"],
      ["delivery.pending.load", "   "],
    ]) {
      const sourceDir = mkTmpRoot();
      writeSourceFixture(sourceDir);
      writeSqliteV2Fixture(
        sourceDir,
        ids.map((id) => ({
          database: "state",
          id,
          p50Ms: 1,
          p95Ms: 2,
          plan: {
            fullTableScans: ["SCAN delivery_queue_entries"],
            indexes: [],
            raw: ["SCAN delivery_queue_entries"],
            tempSorts: [],
          },
          rows: 1000,
          runs: 12,
          sql: "SELECT id FROM delivery_queue_entries",
        })),
      );

      expect(() => buildMarkdown(sourceDir, null)).toThrow(
        "[source-performance] invalid SQLite scenario ID:",
      );
    }
  });

  it("rejects malformed v2 SQLite metrics and normalized plans", () => {
    const invalidQueries = [
      {
        database: "state",
        id: "delivery.pending.load",
        p50Ms: 10,
        p95Ms: null,
        plan: {
          fullTableScans: ["SCAN delivery_queue_entries"],
          indexes: [],
          raw: ["SCAN delivery_queue_entries"],
          tempSorts: [],
        },
        rows: 1000,
        runs: 12,
        sql: "SELECT id FROM delivery_queue_entries",
      },
      {
        database: "state",
        id: "delivery.pending.load",
        p50Ms: 10,
        p95Ms: 12,
        plan: {
          fullTableScans: [42],
          indexes: [],
          raw: ["SCAN delivery_queue_entries"],
          tempSorts: [],
        },
        rows: 1000,
        runs: 12,
        sql: "SELECT id FROM delivery_queue_entries",
      },
      {
        database: "state",
        id: "delivery.pending.load",
        p50Ms: 10,
        p95Ms: 12,
        plan: {
          fullTableScans: [],
          indexes: ["idx_fake"],
          raw: ["SCAN delivery_queue_entries"],
          tempSorts: [],
        },
        rows: 1000,
        runs: 12,
        sql: "SELECT id FROM delivery_queue_entries",
      },
    ];

    for (const query of invalidQueries) {
      const sourceDir = mkTmpRoot();
      writeSourceFixture(sourceDir);
      writeSqliteV2Fixture(sourceDir, [query]);

      expect(() => buildMarkdown(sourceDir, null)).toThrow(
        /\[source-performance\] invalid SQLite scenario (metrics|plan):/,
      );
    }
  });

  it("rejects control characters in v2 SQLite display fields", () => {
    const sourceDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    writeSqliteV2Fixture(sourceDir, [
      {
        database: "state",
        id: "delivery.pending\nload",
        p50Ms: 10,
        p95Ms: 12,
        plan: {
          fullTableScans: [],
          indexes: ["idx_delivery_queue_pending"],
          raw: ["SEARCH delivery_queue_entries USING INDEX idx_delivery_queue_pending"],
          tempSorts: [],
        },
        rows: 1000,
        runs: 12,
        sql: "SELECT id FROM delivery_queue_entries",
      },
    ]);

    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      "[source-performance] invalid SQLite scenario ID:",
    );
  });

  it("renders legacy SQLite artifacts without manufacturing baseline matches", () => {
    const sourceDir = mkTmpRoot();
    const baselineDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    writeSourceFixture(baselineDir);

    const markdown = buildMarkdown(sourceDir, baselineDir);

    expect(markdown).toContain("| current | legacy | smoke | n/a | n/a | n/a |");
    expect(markdown).toContain(
      "| legacy query 1 | unknown | 1 | n/a | 0.1ms | 0.2ms | n/a | n/a | n/a | n/a |",
    );
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

  it("rejects extension memory artifacts without combined-process context", () => {
    const sourceDir = mkTmpRoot();
    writeSourceFixture(sourceDir);
    writeJson(path.join(sourceDir, "extension-memory.json"), {
      topByDeltaMb: [
        { dir: "extensions/browser", maxRssMb: 80, deltaFromBaselineMb: 12, status: "ok" },
      ],
    });

    expect(() => buildMarkdown(sourceDir, null)).toThrow(
      "[source-performance] incomplete extension memory context:",
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
