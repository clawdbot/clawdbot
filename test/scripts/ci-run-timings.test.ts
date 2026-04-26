import { describe, expect, it } from "vitest";
import {
  parseRunTimingArgs,
  selectLatestMainPushCiRun,
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
    ).toMatchObject({ databaseId: 1 });
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
    ).toMatchObject({ databaseId: 3 });
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
