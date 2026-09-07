// Ci Run Timings tests cover ci run timings script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectRunJobsFromPages,
  isRetryableGhJsonErrorMessage,
  parseRunTimingArgs,
  selectLatestMainPushCiRun,
  summarizePnpmStoreWarmupBarrier,
  summarizeRunTimings,
} from "../../scripts/ci-run-timings.mjs";

describe("scripts/ci-run-timings.mjs", () => {
  it("separates start delay from job duration without mislabeling dependency wait", () => {
    const summary = summarizeRunTimings(
      {
        conclusion: "success",
        createdAt: "2026-04-22T10:00:00Z",
        jobs: [
          {
            completedAt: "2026-04-22T10:01:20Z",
            conclusion: "success",
            name: "slow",
            startedAt: "2026-04-22T10:00:20Z",
            status: "completed",
          },
          {
            completedAt: "2026-04-22T10:01:00Z",
            conclusion: "success",
            name: "queued",
            startedAt: "2026-04-22T10:00:50Z",
            status: "completed",
          },
          {
            completedAt: "2026-04-22T10:00:01Z",
            conclusion: "skipped",
            name: "matrix.check_name",
            startedAt: "2026-04-22T10:00:01Z",
            status: "completed",
          },
        ],
        status: "completed",
        updatedAt: "2026-04-22T10:01:30Z",
      },
      2,
    );

    expect(summary.wallSeconds).toBe(90);
    expect(summary.byDuration.map((job) => [job.name, job.durationSeconds])).toEqual([
      ["slow", 60],
      ["queued", 10],
    ]);
    expect(summary.byStartDelay.map((job) => [job.name, job.startDelaySeconds])).toEqual([
      ["queued", 50],
      ["slow", 20],
    ]);
  });

  it("rejects empty CI job payloads instead of printing empty timing evidence", () => {
    expect(() =>
      summarizeRunTimings({
        conclusion: "success",
        createdAt: "2026-04-22T10:00:00Z",
        jobs: [],
        status: "completed",
        updatedAt: "2026-04-22T10:01:30Z",
      }),
    ).toThrow("CI run timing summary requires at least one job");
  });

  it("selects the push CI run for the current main SHA", () => {
    expect(
      selectLatestMainPushCiRun(
        [
          {
            databaseId: 3,
            event: "issue_comment",
            headSha: "current",
          },
          {
            databaseId: 2,
            event: "push",
            headSha: "older",
          },
          {
            databaseId: 1,
            event: "push",
            headSha: "current",
          },
        ],
        "current",
      ),
    ).toEqual({
      databaseId: 1,
      event: "push",
      headSha: "current",
    });
  });

  it("normalizes paginated GitHub Actions job payloads", () => {
    expect(
      collectRunJobsFromPages([
        {
          jobs: [
            {
              completed_at: "2026-06-01T13:26:16Z",
              conclusion: "success",
              id: 101,
              name: "preflight",
              started_at: "2026-06-01T13:25:16Z",
              status: "completed",
            },
          ],
        },
        {
          jobs: [
            {
              completedAt: "2026-06-01T13:28:00Z",
              conclusion: "failure",
              databaseId: 102,
              name: "ci-timings-summary",
              startedAt: "2026-06-01T13:27:00Z",
              status: "completed",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        completedAt: "2026-06-01T13:26:16Z",
        conclusion: "success",
        createdAt: null,
        databaseId: 101,
        labels: [],
        name: "preflight",
        runnerGroupName: null,
        runnerName: null,
        startedAt: "2026-06-01T13:25:16Z",
        status: "completed",
      },
      {
        completedAt: "2026-06-01T13:28:00Z",
        conclusion: "failure",
        createdAt: null,
        databaseId: 102,
        labels: [],
        name: "ci-timings-summary",
        runnerGroupName: null,
        runnerName: null,
        startedAt: "2026-06-01T13:27:00Z",
        status: "completed",
      },
    ]);
  });

  it("retries transient GitHub API failures while preserving auth failures", () => {
    for (const message of [
      "gh: API secondary rate limit exceeded (HTTP 403)",
      "gh: HTTP 429: too many requests",
      "Command failed: gh api repos/openclaw/openclaw/actions/runs/1/jobs\nHTTP 502",
      "read ECONNRESET",
    ]) {
      expect(isRetryableGhJsonErrorMessage(message)).toBe(true);
    }

    expect(
      isRetryableGhJsonErrorMessage("gh: Resource not accessible by integration (HTTP 403)"),
    ).toBe(false);
  });

  it("summarizes the pnpm store warmup fanout barrier", () => {
    expect(
      summarizePnpmStoreWarmupBarrier({
        conclusion: "success",
        createdAt: "2026-05-28T23:03:01Z",
        jobs: [
          {
            completedAt: "2026-05-28T23:04:05Z",
            conclusion: "success",
            name: "preflight",
            startedAt: "2026-05-28T23:03:55Z",
            status: "completed",
          },
          {
            completedAt: "2026-05-28T23:04:27Z",
            conclusion: "success",
            name: "pnpm-store-warmup",
            startedAt: "2026-05-28T23:04:07Z",
            status: "completed",
          },
          {
            completedAt: "2026-05-28T23:06:26Z",
            conclusion: "success",
            name: "checks-fast-bundled-protocol",
            startedAt: "2026-05-28T23:04:29Z",
            status: "completed",
          },
          {
            completedAt: "2026-05-28T23:04:28Z",
            conclusion: "skipped",
            name: "check-docs",
            startedAt: "2026-05-28T23:04:28Z",
            status: "completed",
          },
          {
            completedAt: "2026-05-28T23:04:35Z",
            conclusion: "success",
            name: "security-fast",
            startedAt: "2026-05-28T23:03:55Z",
            status: "completed",
          },
          {
            completedAt: "2026-05-28T23:05:30Z",
            conclusion: "success",
            name: "checks-node-compat-node24",
            startedAt: "2026-05-28T23:04:30Z",
            status: "completed",
          },
        ],
        status: "completed",
        updatedAt: "2026-05-28T23:07:33Z",
      }),
    ).toEqual({
      activePostWarmupJobCount: 1,
      firstPostWarmupStartDelaySeconds: 2,
      postWarmupP95StartDelaySeconds: 2,
      postWarmupStartedWithinWindow: 1,
      preflightToWarmupCompleteSeconds: 22,
      preflightToWarmupStartSeconds: 2,
      warmupDurationSeconds: 20,
      warmupResult: "completed/success",
      windowSeconds: 5,
    });
  });

  it("falls back to the newest push CI run when the exact SHA has not appeared yet", () => {
    expect(
      selectLatestMainPushCiRun(
        [
          {
            databaseId: 4,
            event: "issue_comment",
            headSha: "current",
          },
          {
            databaseId: 3,
            event: "push",
            headSha: "previous",
          },
        ],
        "current",
      ),
    ).toEqual({
      databaseId: 3,
      event: "push",
      headSha: "previous",
    });
  });

  it("ignores pnpm passthrough sentinels when parsing monitor args", () => {
    expect(parseRunTimingArgs(["--latest-main", "--", "--limit", "3"])).toEqual({
      compareHours: 12,
      detailRuns: 100,
      explicitRunId: undefined,
      json: false,
      limit: 3,
      outputPath: null,
      recentLimit: null,
      trendHours: null,
      useLatestMain: true,
    });
  });

  it("parses strict positive integer monitor limits", () => {
    expect(parseRunTimingArgs(["123456", "--limit=7"])).toEqual({
      compareHours: 12,
      detailRuns: 100,
      explicitRunId: "123456",
      json: false,
      limit: 7,
      outputPath: null,
      recentLimit: null,
      trendHours: null,
      useLatestMain: false,
    });
    expect(parseRunTimingArgs(["--recent", "4"]).recentLimit).toBe(4);
  });

  it("parses bounded trend comparison and JSON report options", () => {
    expect(
      parseRunTimingArgs([
        "--trend-hours=72",
        "--compare-hours",
        "12",
        "--detail-runs=80",
        "--json",
        "--output",
        "ci-trend.json",
      ]),
    ).toEqual({
      compareHours: 12,
      detailRuns: 80,
      explicitRunId: undefined,
      json: true,
      limit: 15,
      outputPath: "ci-trend.json",
      recentLimit: null,
      trendHours: 72,
      useLatestMain: false,
    });
  });

  it("rejects malformed monitor limits instead of falling back", () => {
    for (const args of [
      ["--limit", "3jobs"],
      ["--limit", "0"],
      ["--limit=1e3"],
      ["--recent", "recent"],
      ["--recent", "0"],
      ["--trend-hours", "0"],
      ["--compare-hours", "1.5"],
      ["--detail-runs", "all"],
    ]) {
      expect(() => parseRunTimingArgs(args)).toThrow("must be a positive integer");
    }
  });

  it("rejects missing monitor limits instead of treating flags as values", () => {
    for (const args of [
      ["--limit"],
      ["--limit", "--recent", "4"],
      ["--limit", "-h"],
      ["--recent"],
      ["--recent", "-h"],
      ["--trend-hours"],
      ["--compare-hours", "--json"],
      ["--detail-runs"],
      ["--output="],
    ]) {
      expect(() => parseRunTimingArgs(args)).toThrow("requires a value");
    }
  });

  it("rejects unknown monitor flags and duplicate run ids", () => {
    expect(() => parseRunTimingArgs(["--run-id", "123456"])).toThrow(
      "Unknown CI run timing option: --run-id",
    );
    expect(() => parseRunTimingArgs(["123456", "789012"])).toThrow(
      "Unexpected CI run id argument: 789012",
    );
  });

  it("rejects ambiguous monitor modes and incomplete comparison windows", () => {
    expect(() => parseRunTimingArgs(["--recent", "3", "--latest-main"])).toThrow(
      "--recent cannot be combined",
    );
    expect(() => parseRunTimingArgs(["123456", "--latest-main"])).toThrow(
      "A run id cannot be combined",
    );
    expect(() => parseRunTimingArgs(["--trend-hours", "72", "--recent", "3"])).toThrow(
      "--trend-hours cannot be combined",
    );
    expect(() => parseRunTimingArgs(["--trend-hours", "23"])).toThrow("must cover at least two");
    expect(() => parseRunTimingArgs(["--json"])).toThrow("require --trend-hours");
  });

  it("balances trend samples, keeps reruns attempt-specific, and counts API retries", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "openclaw-ci-timings-"));
    const fakeGhPath = path.join(fixtureDir, "gh");
    const reportPath = path.join(fixtureDir, "reports", "trend.json");
    const retryMarkerPath = path.join(fixtureDir, "retried");
    const retryWaitsPath = path.join(fixtureDir, "retry-waits.txt");
    const retryClockPath = path.join(fixtureDir, "retry-clock.mjs");
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const fixtureNowMs = Date.now();
    writeFileSync(retryWaitsPath, "");
    // Only this CLI child skips elapsed backoff; the requested delay remains asserted.
    writeFileSync(
      retryClockPath,
      `import { appendFileSync } from "node:fs";
const wait = Atomics.wait;
Atomics.wait = (array, index, value, timeout) => {
  appendFileSync(${JSON.stringify(retryWaitsPath)}, String(timeout) + "\\n");
  return wait(array, index, value, 0);
};
`,
    );
    writeFileSync(
      fakeGhPath,
      `#!/usr/bin/env node
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
const now = Number(process.env.FIXTURE_NOW_MS);
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
if (endpoint.includes("actions/workflows/ci.yml/runs?")) {
  console.log(JSON.stringify({ workflow_runs: [
    { id: 101, status: "completed", conclusion: "success", created_at: iso(-60 * 60_000), updated_at: iso(-50 * 60_000), head_sha: "latest", run_attempt: 1, html_url: "https://example.test/101" },
    { id: 104, status: "completed", conclusion: "success", created_at: iso(-90 * 60_000), updated_at: iso(-80 * 60_000), head_sha: "latest-unsampled", run_attempt: 1, html_url: "https://example.test/104" },
    { id: 102, status: "completed", conclusion: "cancelled", created_at: iso(-2 * 60 * 60_000), updated_at: iso(-119 * 60_000), head_sha: "cancelled", run_attempt: 1, html_url: "https://example.test/102" },
    { id: 106, status: "completed", conclusion: "timed_out", created_at: iso(-3 * 60 * 60_000), updated_at: iso(-2 * 60 * 60_000 - 50 * 60_000), head_sha: "timed-out", run_attempt: 1, html_url: "https://example.test/106" },
    { id: 103, status: "completed", conclusion: "success", created_at: iso(-13 * 60 * 60_000), updated_at: iso(-12 * 60 * 60_000 - 50 * 60_000), head_sha: "prior-rerun", run_attempt: 2, html_url: "https://example.test/103" }
  ] }));
} else if (endpoint.includes("actions/runs/101/attempts/1/jobs?")) {
  if (!existsSync(process.env.FIXTURE_RETRY_MARKER)) {
    writeFileSync(process.env.FIXTURE_RETRY_MARKER, "retried\\n");
    console.error("HTTP 502: fixture transient failure");
    process.exit(1);
  }
  const runStart = now - 60 * 60_000;
  const at = (seconds) => new Date(runStart + seconds * 1000).toISOString();
  console.log(JSON.stringify({ total_count: 4, jobs: [
    { id: 1, name: "preflight", status: "completed", conclusion: "success", created_at: at(10), started_at: at(20), completed_at: at(60), labels: ["blacksmith-4vcpu-ubuntu-2404"], runner_name: "blacksmith-test", runner_group_name: "blacksmith" },
    { id: 2, name: "checks-node-compact-large-1", status: "completed", conclusion: "success", created_at: at(60), started_at: at(65), completed_at: at(500), labels: ["blacksmith-8vcpu-ubuntu-2404"], runner_name: "blacksmith-test", runner_group_name: "blacksmith" },
    { id: 3, name: "openclaw/ci-gate", status: "completed", conclusion: "success", created_at: at(500), started_at: at(501), completed_at: at(510), labels: ["ubuntu-24.04"], runner_name: "GitHub Actions", runner_group_name: "GitHub Actions" },
    { id: 4, name: "matrix.synthetic", status: "completed", conclusion: "success", created_at: at(510), started_at: at(511), completed_at: at(520), labels: ["ubuntu-24.04"], runner_name: "GitHub Actions", runner_group_name: "GitHub Actions" }
  ] }));
} else if (endpoint.includes("actions/runs/103/attempts/2/jobs?")) {
  const runStart = now - 12 * 60 * 60_000 - 55 * 60_000;
  const at = (seconds) => new Date(runStart + seconds * 1000).toISOString();
  console.log(JSON.stringify({ total_count: 2, jobs: [
    { id: 5, name: "preflight", status: "completed", conclusion: "success", created_at: at(10), started_at: at(18), completed_at: at(58), labels: ["blacksmith-4vcpu-ubuntu-2404"], runner_name: "blacksmith-test", runner_group_name: "blacksmith" },
    { id: 6, name: "checks-node-compact-large-1", status: "completed", conclusion: "success", created_at: at(58), started_at: at(62), completed_at: at(470), labels: ["blacksmith-8vcpu-ubuntu-2404"], runner_name: "blacksmith-test", runner_group_name: "blacksmith" }
  ] }));
} else {
  console.error("unexpected gh invocation", args.join(" "));
  process.exit(2);
}
`,
    );
    chmodSync(fakeGhPath, 0o755);

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(retryClockPath).href,
          "scripts/ci-run-timings.mjs",
          "--trend-hours",
          "24",
          "--compare-hours",
          "12",
          "--detail-runs",
          "2",
          "--json",
          "--output",
          reportPath,
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            FIXTURE_NOW_MS: String(fixtureNowMs),
            FIXTURE_RETRY_MARKER: retryMarkerPath,
            GH_TOKEN: "fixture-ci-timing-token",
            OPENCLAW_GH_BIN: fakeGhPath,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(retryWaitsPath, "utf8")).toBe("1000\n");
      const report = JSON.parse(result.stdout);
      expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(report);
      expect(report.apiRequests).toEqual({ jobs: 3, runList: 1, total: 4 });
      expect(report.sampling).toEqual({
        detailedSuccessfulRuns: 2,
        eligibleSuccessfulRuns: 3,
      });
      expect(report.cohorts.comparison.outcomes).toMatchObject({
        cancelled: 1,
        cancellationRate: 0.25,
        nonCancelledPassRate: 2 / 3,
        success: 2,
        timedOut: 1,
        total: 4,
      });
      expect(report.cohorts.prior.runMetrics.successfulWallSeconds.p50).toBeNull();
      expect(report.cohorts.prior.runMetrics.workflowAdmissionSeconds.p50).toBeNull();
      expect(report.cohorts.prior.samples.detailedSuccessfulRuns).toBe(1);
      expect(report.cohorts.prior.jobMetrics.executionSeconds.count).toBe(2);
      expect(report.cohorts.comparison.jobMetrics.runnerQueueSeconds).toMatchObject({
        count: 2,
        max: 10,
        p95: 10,
      });
      expect(report.cohorts.comparison.jobMetrics.dependencyGatedSeconds.p95).toBe(50);
      expect(report.cohorts.comparison.runMetrics.workflowAdmissionSeconds.p95).toBe(10);
      expect(report.cohorts.comparison.criticalOwners).toEqual([
        { name: "checks-node-compact-large-1", runs: 1 },
      ]);
      expect(
        report.jobs.find((job: { name: string }) => job.name === "checks-node-compact-large-1"),
      ).toMatchObject({
        comparison: { executionSeconds: { count: 1 } },
        prior: { executionSeconds: { count: 1 } },
      });
      expect(report.runs[0].jobTimings.map((job: { name: string }) => job.name)).toEqual([
        "preflight",
        "checks-node-compact-large-1",
      ]);
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });
  it("excludes manual, failed, and unfinished runs from recent main timings", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "openclaw-ci-timings-recent-"));
    const fakeGhPath = path.join(fixtureDir, "gh");
    const callsPath = path.join(fixtureDir, "calls.jsonl");
    writeFileSync(
      fakeGhPath,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS_PATH, JSON.stringify(args) + "\\n");
if (args[0] === "run" && args[1] === "list") {
  console.log(JSON.stringify([
    { databaseId: 201, event: "workflow_dispatch", headSha: "manual", status: "completed", conclusion: "success" },
    { databaseId: 202, event: "push", headSha: "failed", status: "completed", conclusion: "failure" },
    { databaseId: 203, event: "push", headSha: "running", status: "in_progress", conclusion: "" },
    { databaseId: 204, event: "push", headSha: "first", status: "completed", conclusion: "success" },
    { databaseId: 205, event: "push", headSha: "second", status: "completed", conclusion: "success" }
  ]));
} else if (args[0] === "run" && args[1] === "view") {
  console.log(JSON.stringify({ status: "completed", conclusion: "success", createdAt: "2026-08-31T00:00:00Z", updatedAt: "2026-08-31T00:01:00Z" }));
} else if (args[0] === "api" && args.some((arg) => arg.includes("/jobs?"))) {
  console.log(JSON.stringify({ total_count: 1, jobs: [{ id: 1, name: "checks", status: "completed", conclusion: "success", started_at: "2026-08-31T00:00:10Z", completed_at: "2026-08-31T00:00:40Z" }] }));
} else {
  process.exit(2);
}
`,
    );
    chmodSync(fakeGhPath, 0o755);
    try {
      const result = spawnSync(process.execPath, ["scripts/ci-run-timings.mjs", "--recent", "2"], {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "fixture-token",
          OPENCLAW_GH_BIN: fakeGhPath,
          FIXTURE_CALLS_PATH: callsPath,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.match(/CI run \d+/gu)).toEqual(["CI run 204", "CI run 205"]);
      const calls: string[][] = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls[0]?.slice(calls[0].indexOf("--event"), calls[0].indexOf("--event") + 2)).toEqual(
        ["--event", "push"],
      );
      expect(
        calls.filter((args) => args[0] === "run" && args[1] === "view").map((args) => args[2]),
      ).toEqual(["204", "205"]);
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });
});
