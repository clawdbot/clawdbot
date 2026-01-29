import { describe, it, expect } from "vitest";
import { scheduleToRepeatOpts, jobSchedulerKey } from "./queue.js";
import type { CronSchedule } from "../types.js";

describe("scheduleToRepeatOpts", () => {
  const now = Date.now();

  it("handles one-shot (at) schedule", () => {
    const schedule: CronSchedule = { kind: "at", atMs: now + 60_000 };
    const result = scheduleToRepeatOpts(schedule, now);
    expect(result).toEqual({ delay: 60_000 });
  });

  it("handles interval (every) schedule", () => {
    const schedule: CronSchedule = { kind: "every", everyMs: 300_000 };
    const result = scheduleToRepeatOpts(schedule, now);
    expect(result).toEqual({ repeat: { every: 300_000 } });
  });

  it("handles interval (every) schedule with anchorMs", () => {
    const anchorMs = now - 60_000; // 1 minute ago
    const schedule: CronSchedule = { kind: "every", everyMs: 300_000, anchorMs };
    const result = scheduleToRepeatOpts(schedule, now);
    expect(result).toEqual({ repeat: { every: 300_000, startDate: new Date(anchorMs) } });
  });

  it("handles cron expression schedule", () => {
    const schedule: CronSchedule = { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" };
    const result = scheduleToRepeatOpts(schedule, now);
    expect(result).toEqual({ repeat: { pattern: "0 9 * * *", tz: "America/New_York" } });
  });

  it("handles past one-shot schedule with 0 delay", () => {
    const schedule: CronSchedule = { kind: "at", atMs: now - 60_000 };
    const result = scheduleToRepeatOpts(schedule, now);
    expect(result).toEqual({ delay: 0 });
  });
});

describe("jobSchedulerKey", () => {
  it("generates deterministic key", () => {
    const id = "test-job-123";
    expect(jobSchedulerKey(id)).toBe("cron-test-job-123");
    expect(jobSchedulerKey(id)).toBe(jobSchedulerKey(id));
  });
});
