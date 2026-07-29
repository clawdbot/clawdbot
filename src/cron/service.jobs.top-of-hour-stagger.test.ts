// Top-of-hour stagger tests cover spreading jobs that would otherwise collide.
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import type { CronJob } from "./types.js";

const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function stableOffsetMs(jobId: string, windowMs: number) {
  const digest = crypto.createHash("sha256").update(jobId).digest();
  return digest.readUInt32BE(0) % windowMs;
}

function createCronJob(params: {
  id: string;
  expr: string;
  tz?: string;
  staggerMs?: number;
  state?: CronJob["state"];
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: Date.parse("2026-02-06T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-06T00:00:00.000Z"),
    schedule: { kind: "cron", expr: params.expr, tz: params.tz, staggerMs: params.staggerMs },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
    state: params.state ?? {},
  };
}

describe("computeJobNextRunAtMs top-of-hour staggering", () => {
  it("applies deterministic 0..5m stagger for recurring top-of-hour schedules", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createCronJob({ id: "hourly-job-a", expr: "0 * * * *", tz: "UTC" });
    const offsetMs = stableOffsetMs(job.id, DEFAULT_TOP_OF_HOUR_STAGGER_MS);

    const next = computeJobNextRunAtMs(job, now);

    expect(next).toBe(Date.parse("2026-02-06T11:00:00.000Z") + offsetMs);
    expect(offsetMs).toBeGreaterThanOrEqual(0);
    expect(offsetMs).toBeLessThan(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("can still fire in the current hour when the staggered slot is ahead", () => {
    const now = Date.parse("2026-02-06T10:02:00.000Z");
    const thisHour = Date.parse("2026-02-06T10:00:00.000Z");
    const nextHour = Date.parse("2026-02-06T11:00:00.000Z");
    const job = createCronJob({ id: "hourly-job-b", expr: "0 * * * *", tz: "UTC" });
    const offsetMs = stableOffsetMs(job.id, DEFAULT_TOP_OF_HOUR_STAGGER_MS);

    const expected = thisHour + offsetMs > now ? thisHour + offsetMs : nextHour + offsetMs;
    const next = computeJobNextRunAtMs(job, now);

    expect(next).toBe(expected);
  });

  it("also applies to 6-field top-of-hour cron expressions", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createCronJob({ id: "hourly-job-seconds", expr: "0 0 * * * *", tz: "UTC" });
    const offsetMs = stableOffsetMs(job.id, DEFAULT_TOP_OF_HOUR_STAGGER_MS);

    const next = computeJobNextRunAtMs(job, now);

    expect(next).toBe(Date.parse("2026-02-06T11:00:00.000Z") + offsetMs);
  });

  it("supports explicit stagger for non top-of-hour cron expressions", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const windowMs = 30_000;
    const job = createCronJob({
      id: "minute-17-staggered",
      expr: "17 * * * *",
      tz: "UTC",
      staggerMs: windowMs,
    });
    const offsetMs = stableOffsetMs(job.id, windowMs);

    const next = computeJobNextRunAtMs(job, now);

    expect(next).toBe(Date.parse("2026-02-06T10:17:00.000Z") + offsetMs);
  });

  it("keeps schedules exact when staggerMs is set to 0", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createCronJob({ id: "daily-job", expr: "0 7 * * *", tz: "UTC", staggerMs: 0 });

    const next = computeJobNextRunAtMs(job, now);

    expect(next).toBe(Date.parse("2026-02-07T07:00:00.000Z"));
  });

  it("caches stable stagger offsets per job/window", () => {
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createCronJob({ id: "hourly-job-cache", expr: "0 * * * *", tz: "UTC" });
    const hashSpy = vi.spyOn(crypto, "createHash");

    const first = computeJobNextRunAtMs(job, now);
    const second = computeJobNextRunAtMs(job, now);

    expect(second).toBe(first);
    expect(hashSpy).toHaveBeenCalledTimes(1);
    hashSpy.mockRestore();
  });
});
