// Control UI tests cover cron filters behavior.
import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.ts";
import { getVisibleCronJobs } from "./cron.ts";

function job(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: `Job ${id}`,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    ...overrides,
  };
}

describe("getVisibleCronJobs", () => {
  it("returns all jobs when no client-side filters are active", () => {
    const jobs = [job("a"), job("b", { schedule: { kind: "cron", expr: "0 9 * * *" } })];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsScheduleKindFilter: "all",
      cronJobsLastStatusFilter: "all",
    });
    expect(visible).toHaveLength(2);
  });

  it("filters by schedule kind", () => {
    const jobs = [
      job("a", { schedule: { kind: "at", at: "2026-03-01T08:00:00Z" } }),
      job("b", { schedule: { kind: "every", everyMs: 60_000 } }),
      job("c", { schedule: { kind: "cron", expr: "0 9 * * *" } }),
    ];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "all",
    });
    expect(visible.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("drops jobs with unsupported schedules before rendering", () => {
    const jobs = [
      job("valid", { schedule: { kind: "cron", expr: "0 9 * * *" } }),
      job("invalid", { schedule: {} as CronJob["schedule"] }),
    ];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsScheduleKindFilter: "all",
      cronJobsLastStatusFilter: "all",
    });
    expect(visible.map((entry) => entry.id)).toEqual(["valid"]);
  });

  it("filters by last status", () => {
    const jobs = [
      job("ok", { state: { lastStatus: "ok", lastRunAtMs: 1 } }),
      job("error", { state: { lastStatus: "error", lastRunAtMs: 2 } }),
      job("unknown"),
    ];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsScheduleKindFilter: "all",
      cronJobsLastStatusFilter: "error",
    });
    expect(visible.map((entry) => entry.id)).toEqual(["error"]);
  });

  it("filters unknown and preferred last-run statuses", () => {
    const jobs = [
      job("preferred", { state: { lastRunStatus: "skipped", lastRunAtMs: 1 } }),
      job("legacy", { state: { lastStatus: "skipped", lastRunAtMs: 2 } }),
      job("missing"),
    ];

    const skipped = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsScheduleKindFilter: "all",
      cronJobsLastStatusFilter: "skipped",
    });
    const unknown = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsScheduleKindFilter: "all",
      cronJobsLastStatusFilter: "unknown",
    });

    expect(skipped.map((entry) => entry.id)).toEqual(["preferred", "legacy"]);
    expect(unknown.map((entry) => entry.id)).toEqual(["missing"]);
  });

  it("combines schedule and last-status filters", () => {
    const jobs = [
      job("a", {
        schedule: { kind: "cron", expr: "0 9 * * *" },
        state: { lastStatus: "ok", lastRunAtMs: 1 },
      }),
      job("b", {
        schedule: { kind: "cron", expr: "0 10 * * *" },
        state: { lastStatus: "error", lastRunAtMs: 2 },
      }),
      job("c", {
        schedule: { kind: "every", everyMs: 60_000 },
        state: { lastStatus: "error", lastRunAtMs: 3 },
      }),
    ];
    const visible = getVisibleCronJobs({
      cronJobs: jobs,
      cronJobsScheduleKindFilter: "cron",
      cronJobsLastStatusFilter: "error",
    });
    expect(visible.map((entry) => entry.id)).toEqual(["b"]);
  });
});
