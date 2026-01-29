import { describe, expect, it } from "vitest";

import type { CronJob } from "../types.js";
import { computeJobNextRunAtMs } from "./jobs.js";

function makeEveryJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    enabled: true,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    schedule: { kind: "every", everyMs: 3600_000 }, // 1 hour
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
    ...overrides,
  };
}

describe("computeJobNextRunAtMs", () => {
  it("anchors to lastRunAtMs for every jobs that have run", () => {
    const job = makeEveryJob({
      state: { lastRunAtMs: 1000 },
    });
    const nowMs = 5000;
    const next = computeJobNextRunAtMs(job, nowMs);
    // Should be lastRunAtMs + everyMs, NOT nowMs + everyMs
    expect(next).toBe(1000 + 3600_000);
  });

  it("falls back to anchorMs when no lastRunAtMs", () => {
    const job = makeEveryJob({
      schedule: { kind: "every", everyMs: 3600_000, anchorMs: 500 },
      state: {}, // No lastRunAtMs
    });
    const next = computeJobNextRunAtMs(job, 1000);
    expect(next).toBe(500 + 3600_000);
  });

  it("falls back to nowMs when neither lastRunAtMs nor anchorMs exist", () => {
    const job = makeEveryJob({
      schedule: { kind: "every", everyMs: 3600_000 }, // No anchorMs
      state: {}, // No lastRunAtMs
    });
    const next = computeJobNextRunAtMs(job, 1000);
    expect(next).toBe(1000 + 3600_000);
  });

  it("does not affect cron expression schedules", () => {
    const job: CronJob = {
      id: "test-job",
      enabled: true,
      createdAtMs: 1000,
      updatedAtMs: 1000,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" }, // Daily at 9am UTC
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "test" },
      state: { lastRunAtMs: 500 }, // Should be ignored for cron expr
    };
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeJobNextRunAtMs(job, nowMs);
    // Should be next 9am UTC, not anchored to lastRunAtMs
    expect(next).toBe(Date.parse("2025-12-13T09:00:00.000Z"));
  });

  it("returns undefined for disabled jobs", () => {
    const job = makeEveryJob({ enabled: false });
    const next = computeJobNextRunAtMs(job, 1000);
    expect(next).toBeUndefined();
  });
});
