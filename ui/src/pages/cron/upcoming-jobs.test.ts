import { describe, expect, it } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { groupUpcomingJobs } from "./upcoming-jobs.ts";

function buildJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job",
    name: "Sample",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "systemEvent", text: "tick" },
    ...overrides,
  } as CronJob;
}

const NOW = Date.now();

describe("groupUpcomingJobs", () => {
  it("separates time-scheduled jobs from event-driven ones", () => {
    const every = buildJob({
      id: "every-1",
      schedule: { kind: "every", everyMs: 60_000 },
      state: { nextRunAtMs: NOW + 30_000 },
    });
    const cron = buildJob({
      id: "cron-1",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      state: { nextRunAtMs: NOW + 3_600_000 },
    });
    const onExit = buildJob({
      id: "on-exit-1",
      schedule: { kind: "on-exit", command: "/bin/watch" },
    });
    const stream = buildJob({
      id: "stream-1",
      schedule: { kind: "stream", command: ["tail", "-f"] },
    });

    const { scheduled, event } = groupUpcomingJobs([every, cron, onExit, stream], NOW);

    expect(scheduled).toHaveLength(2);
    expect(scheduled.map((entry) => entry.job.id)).toEqual(["every-1", "cron-1"]);
    expect(scheduled[0]!.relTime).not.toBe("n/a");

    expect(event).toHaveLength(2);
    expect(event.map((entry) => entry.job.id)).toEqual(["on-exit-1", "stream-1"]);
  });

  it("sorts scheduled jobs by nextRunAtMs ascending", () => {
    const later = buildJob({
      id: "later",
      schedule: { kind: "every", everyMs: 60_000 },
      state: { nextRunAtMs: NOW + 600_000 },
    });
    const sooner = buildJob({
      id: "sooner",
      schedule: { kind: "every", everyMs: 60_000 },
      state: { nextRunAtMs: NOW + 60_000 },
    });

    const { scheduled } = groupUpcomingJobs([later, sooner], NOW);
    expect(scheduled.map((entry) => entry.job.id)).toEqual(["sooner", "later"]);
  });

  it("excludes paused time-scheduled jobs from upcoming", () => {
    const paused = buildJob({
      id: "paused",
      enabled: false,
      state: { nextRunAtMs: NOW + 60_000 },
    });
    const { scheduled, event } = groupUpcomingJobs([paused], NOW);
    expect(scheduled).toHaveLength(0);
    expect(event).toHaveLength(0);
  });

  it("excludes time-scheduled jobs without a finite nextRunAtMs", () => {
    const noNext = buildJob({ id: "no-next", state: { nextRunAtMs: undefined } });
    const { scheduled } = groupUpcomingJobs([noNext], NOW);
    expect(scheduled).toHaveLength(0);
  });

  it("includes event-driven jobs (on-exit/stream) regardless of nextRunAtMs", () => {
    const onExit = buildJob({
      id: "on-exit",
      schedule: { kind: "on-exit", command: "/bin/watch" },
    });
    const { event } = groupUpcomingJobs([onExit], NOW);
    expect(event).toHaveLength(1);
    expect(event[0]!.job.id).toBe("on-exit");
  });

  it("never mixes event-driven jobs into the scheduled (time-based) list", () => {
    const onExit = buildJob({ id: "on-exit", schedule: { kind: "on-exit", command: "/x" } });
    const stream = buildJob({ id: "stream", schedule: { kind: "stream", command: ["x"] } });
    const every = buildJob({
      id: "every",
      state: { nextRunAtMs: NOW + 1000 },
    });

    const { scheduled, event } = groupUpcomingJobs([onExit, stream, every], NOW);

    expect(scheduled.some((entry) => entry.job.schedule.kind === "on-exit")).toBe(false);
    expect(scheduled.some((entry) => entry.job.schedule.kind === "stream")).toBe(false);
    expect(
      event.every(
        (entry) => entry.job.schedule.kind !== "on-exit" && entry.job.schedule.kind !== "stream",
      ),
    ).toBe(false);
  });
});
