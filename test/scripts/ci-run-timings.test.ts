import { describe, expect, it } from "vitest";
import { summarizeRunTimings } from "../../scripts/ci-run-timings.mjs";

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
});
