import { describe, expect, it } from "vitest";
import {
  collectRunJobsFromPages,
  parseRunTimingArgs,
  selectLatestMainPushCiRun,
  summarizePnpmStoreWarmupBarrier,
  summarizeRunTimings,
} from "../../scripts/ci-run-timings.mjs";

describe("scripts/ci-run-timings.mjs", () => {
  it("separates queue time from job duration", () => {
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
    expect(summary.byQueue.map((job) => [job.name, job.queueSeconds])).toEqual([
      ["queued", 50],
      ["slow", 20],
    ]);
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
        databaseId: 101,
        name: "preflight",
        startedAt: "2026-06-01T13:25:16Z",
        status: "completed",
      },
      {
        completedAt: "2026-06-01T13:28:00Z",
        conclusion: "failure",
        databaseId: 102,
        name: "ci-timings-summary",
        startedAt: "2026-06-01T13:27:00Z",
        status: "completed",
      },
    ]);
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
            name: "checks-node-compat-node22",
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
      explicitRunId: undefined,
      limit: 3,
      recentLimit: null,
      useLatestMain: true,
    });
  });
});
