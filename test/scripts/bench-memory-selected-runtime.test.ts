// Selected memory runtime benchmark tests cover CLI parsing and report-budget semantics.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-memory-selected-runtime.mts";

function withReport<T>(payload: unknown, run: (reportPath: string) => T): T {
  const reportPath = path.join(
    os.tmpdir(),
    `openclaw-memory-selected-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  fs.writeFileSync(
    reportPath,
    typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`,
  );
  try {
    return run(reportPath);
  } finally {
    fs.rmSync(reportPath, { force: true });
  }
}

const samples = Array.from({ length: 20 }, (_, index) => index + 1);
const baselineCommit = "a".repeat(40);
const candidateCommit = "b".repeat(40);

type CandidateReport = Parameters<typeof testing.compareP95AgainstBaseline>[0]["candidate"];

function baselineReport(overrides: Record<string, unknown> = {}) {
  return {
    batchSize: 100,
    fixture: "memory-core-selected-runtime",
    mode: "selected-memory-runtime",
    runs: 20,
    runtime: { arch: "x64", node: "v24.15.0", platform: "linux" },
    source: { commit: baselineCommit },
    summary: testing.summarizeLatency(samples),
    version: 2,
    warmLookupNsPerLookup: samples,
    warmup: 1,
    ...overrides,
  };
}

function candidateReport(overrides: Partial<CandidateReport> = {}): CandidateReport {
  return {
    batchSize: 100,
    fixture: "memory-core-selected-runtime",
    firstLookupNs: 1,
    generatedAt: "2026-08-10T00:00:00.000Z",
    lookup: "getSelectedMemoryRuntime",
    mode: "selected-memory-runtime",
    repo: "/candidate",
    runs: 20,
    runtime: { arch: "x64", node: "v24.15.0", platform: "linux" },
    source: { commit: candidateCommit },
    summary: testing.summarizeLatency(samples),
    version: 2,
    warmLookupNsPerLookup: samples,
    warmup: 1,
    ...overrides,
  };
}

function candidateWithField(field: string, value: unknown): CandidateReport {
  const candidate = candidateReport();
  const record = candidate as unknown as Record<string, unknown>;
  if (field.startsWith("runtime.")) {
    const runtime = record.runtime as Record<string, unknown>;
    runtime[field.slice("runtime.".length)] = value;
  } else {
    record[field] = value;
  }
  return candidate;
}

describe("selected memory runtime benchmark script", () => {
  it("uses the legacy fixture without authorization and the P0A fixture with it", () => {
    const runtime = {};
    const authorization = {};

    expect(testing.createMemoryCapabilityFixture(runtime)).toEqual({ runtime });
    expect(testing.createMemoryCapabilityFixture(runtime, authorization)).toEqual({
      authorization,
      runtime,
    });
  });

  it("finds the authorization module only when the target source tree provides it", () => {
    const repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-memory-selected-runtime-repo-"),
    );
    const authorizationPath = path.join(
      repoRoot,
      "src",
      "memory-host-sdk",
      "host",
      "authorization.ts",
    );
    try {
      expect(testing.findLegacyAuthorizationModule(repoRoot)).toBeUndefined();
      fs.mkdirSync(path.dirname(authorizationPath), { recursive: true });
      fs.writeFileSync(authorizationPath, "export {};\n");
      expect(testing.findLegacyAuthorizationModule(repoRoot)).toBe(authorizationPath);
    } finally {
      fs.rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("records a source commit only for a clean target worktree", () => {
    const repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-memory-selected-runtime-git-"),
    );
    const trackedPath = path.join(repoRoot, "tracked.txt");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.name", "Benchmark Test"], { cwd: repoRoot });
      fs.writeFileSync(trackedPath, "initial\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd: repoRoot });
      execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repoRoot });

      expect(testing.resolveSourceCommit(repoRoot)).toMatch(/^[0-9a-f]{40}$/u);

      fs.writeFileSync(trackedPath, "modified\n");
      expect(() => testing.resolveSourceCommit(repoRoot)).toThrow(
        "must be clean to report its commit",
      );

      execFileSync("git", ["checkout", "--", "tracked.txt"], { cwd: repoRoot });
      fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "untracked\n");
      expect(() => testing.resolveSourceCommit(repoRoot)).toThrow(
        "must be clean to report its commit",
      );
    } finally {
      fs.rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("parses bounded benchmark controls and defaults", () => {
    expect(testing.parseArgs([], "/repo")).toEqual({
      batchSize: 100_000,
      json: false,
      maxP95RegressionPct: 15,
      repo: "/repo",
      runs: 20,
      warmup: 3,
    });
    expect(
      testing.parseArgs(
        [
          "--repo",
          "candidate",
          "--batch-size",
          "200",
          "--runs",
          "20",
          "--warmup",
          "1",
          "--output",
          "report.json",
          "--baseline",
          "baseline.json",
          "--max-p95-regression-pct",
          "12.5",
          "--json",
        ],
        "/repo",
      ),
    ).toEqual({
      baseline: "/repo/baseline.json",
      batchSize: 200,
      json: true,
      maxP95RegressionPct: 12.5,
      output: "/repo/report.json",
      repo: "/repo/candidate",
      runs: 20,
      warmup: 1,
    });
    expect(testing.parseArgs(["--help"], "/repo")).toEqual({ help: true });
  });

  it("rejects invalid, missing, duplicate, and unknown flags before running a benchmark", () => {
    expect(() => testing.parseArgs(["--batch-size", "0"])).toThrow(
      "--batch-size must be at least 1",
    );
    expect(() => testing.parseArgs(["--runs", "1.5"])).toThrow("--runs must be an integer");
    expect(() => testing.parseArgs(["--runs", "19"])).toThrow("--runs must be at least 20");
    expect(() => testing.parseArgs(["--warmup", "1.5"])).toThrow("--warmup must be an integer");
    expect(() => testing.parseArgs(["--max-p95-regression-pct", "wat"])).toThrow(
      "--max-p95-regression-pct must be a non-negative number",
    );
    expect(() => testing.parseArgs(["--output"])).toThrow("--output requires a value");
    expect(() => testing.parseArgs(["--json", "--json"])).toThrow(
      "--json was provided more than once",
    );
    expect(() => testing.parseArgs(["--runs", "20", "--runs", "21"])).toThrow(
      "--runs was provided more than once",
    );
    expect(() => testing.parseArgs(["--wat"])).toThrow("Unknown argument: --wat");
  });

  it("reports nearest-rank p50 and p95 warm lookup summaries", () => {
    expect(testing.summarizeLatency(samples)).toEqual({
      count: 20,
      maxNsPerLookup: 20,
      minNsPerLookup: 1,
      p50NsPerLookup: 10,
      p95NsPerLookup: 19,
    });
    expect(() => testing.summarizeLatency(samples.slice(0, 19))).toThrow(
      "p95 requires at least 20 warm lookup samples; received 19",
    );
  });

  it("reads only complete, internally consistent baseline reports", () => {
    const baseline = withReport(baselineReport(), testing.readBaselineReport);
    expect(baseline.source.commit).toBe(baselineCommit);
    expect(baseline.summary).toMatchObject({ count: 20, p95NsPerLookup: 19 });

    const invalidReports: Array<{ expected: string; payload: unknown }> = [
      { expected: "must contain version >= 0", payload: { summary: { p95NsPerLookup: 19 } } },
      {
        expected: "must contain runs >= 20",
        payload: baselineReport({ runs: 19, warmLookupNsPerLookup: samples.slice(0, 19) }),
      },
      {
        expected: "warmLookupNsPerLookup length must equal runs",
        payload: baselineReport({ warmLookupNsPerLookup: samples.slice(0, 19) }),
      },
      {
        expected: "warmLookupNsPerLookup must contain numbers",
        payload: baselineReport({ warmLookupNsPerLookup: [...samples.slice(0, 19), -1] }),
      },
      {
        expected: "must contain summary.maxNsPerLookup",
        payload: baselineReport({ summary: { count: 20, p95NsPerLookup: 19 } }),
      },
      {
        expected: "source.commit must be a full lowercase SHA",
        payload: baselineReport({ source: { commit: "A".repeat(40) } }),
      },
    ];
    for (const { expected, payload } of invalidReports) {
      withReport(payload, (reportPath) => {
        expect(() => testing.readBaselineReport(reportPath)).toThrow(expected);
      });
    }
    for (const [field, value] of [
      ["count", 19],
      ["maxNsPerLookup", 21],
      ["minNsPerLookup", 2],
      ["p50NsPerLookup", 11],
      ["p95NsPerLookup", 20],
    ] as const) {
      const summary = { ...testing.summarizeLatency(samples) } as Record<string, number>;
      summary[field] = value;
      withReport(baselineReport({ summary }), (reportPath) => {
        expect(() => testing.readBaselineReport(reportPath)).toThrow(
          "summary must match warmLookupNsPerLookup",
        );
      });
    }
    withReport("{", (reportPath) => {
      expect(() => testing.readBaselineReport(reportPath)).toThrow(
        "failed to read baseline report",
      );
    });
  });

  it("compares comparable reports across source commits and records both identities", () => {
    const baseline = withReport(baselineReport(), testing.readBaselineReport);
    const comparison = testing.compareP95AgainstBaseline({
      baseline,
      candidate: candidateReport(),
      maxP95RegressionPct: 15,
    });

    expect(comparison).toMatchObject({
      baselineCommit,
      candidateCommit,
      candidateP95NsPerLookup: 19,
      passed: true,
    });
    expect(() => testing.assertP95RegressionWithinBudget(comparison)).not.toThrow();
  });

  it("rejects baseline comparisons with incompatible benchmark identities", () => {
    const baseline = withReport(baselineReport(), testing.readBaselineReport);
    const mismatches = [
      ["version", 3],
      ["mode", "other-mode"],
      ["fixture", "other-fixture"],
      ["batchSize", 101],
      ["runs", 21],
      ["warmup", 2],
      ["runtime.node", "v24.16.0"],
      ["runtime.platform", "darwin"],
      ["runtime.arch", "arm64"],
    ] as const;

    for (const [field, value] of mismatches) {
      expect(() =>
        testing.compareP95AgainstBaseline({
          baseline,
          candidate: candidateWithField(field, value),
          maxP95RegressionPct: 15,
        }),
      ).toThrow(`baseline report is not comparable: ${field}`);
    }
  });

  it("enforces the p95 budget only after compatibility succeeds", () => {
    const baseline = withReport(baselineReport(), testing.readBaselineReport);
    const slowerSamples = Array.from({ length: 20 }, (_, index) => index + 4);
    const slowerCandidate = candidateReport({
      summary: testing.summarizeLatency(slowerSamples),
      warmLookupNsPerLookup: slowerSamples,
    });

    const comparison = testing.compareP95AgainstBaseline({
      baseline,
      candidate: slowerCandidate,
      maxP95RegressionPct: 15,
    });
    expect(comparison.passed).toBe(false);
    expect(() => testing.assertP95RegressionWithinBudget(comparison)).toThrow(
      "warm selected-memory-runtime p95",
    );

    const incompatibleCandidate = candidateWithField("version", 3);
    incompatibleCandidate.summary = testing.summarizeLatency(slowerSamples);
    expect(() =>
      testing.compareP95AgainstBaseline({
        baseline,
        candidate: incompatibleCandidate,
        maxP95RegressionPct: 15,
      }),
    ).toThrow("baseline report is not comparable: version");
  });
});
