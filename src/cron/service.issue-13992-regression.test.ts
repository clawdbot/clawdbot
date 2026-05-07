import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs.js";
import type { CronJob } from "./types.js";

function createCronSystemEventJob(now: number, overrides: Partial<CronJob> = {}): CronJob {
  const { state, ...jobOverrides } = overrides;
  return {
    id: "test-job",
    name: "test job",
    enabled: true,
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    payload: { kind: "systemEvent", text: "test" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    createdAtMs: now,
    updatedAtMs: now,
    ...jobOverrides,
    state: state ? { ...state } : {},
  };
}

describe("issue #13992 regression - cron jobs skip execution", () => {
  it("should NOT recompute nextRunAtMs for past-due jobs by default", () => {
    const now = Date.now();
    const pastDue = now - 60_000; // 1 minute ago

    const job = createCronSystemEventJob(now, {
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue, // This is in the past and should NOT be recomputed
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should not have changed the past-due nextRunAtMs
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("should recompute past-due nextRunAtMs with recomputeExpired when slot already executed", () => {
    // NOTE: in onTimer this recovery branch is used only when due scan found no
    // runnable jobs; this unit test validates the maintenance helper contract.
    const now = Date.now();
    const pastDue = now - 60_000;

    const job = createCronSystemEventJob(now, {
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue,
        lastRunAtMs: pastDue + 1000,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });

    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect((job.state.nextRunAtMs ?? 0) > now).toBe(true);
  });

  it("should NOT recompute past-due nextRunAtMs for running jobs even with recomputeExpired", () => {
    const now = Date.now();
    const pastDue = now - 60_000;

    const job = createCronSystemEventJob(now, {
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue,
        runningAtMs: now - 500,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });

    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("should compute missing nextRunAtMs during maintenance", () => {
    const now = Date.now();

    const job = createCronSystemEventJob(now, {
      state: {
        // nextRunAtMs is missing
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should have computed a nextRunAtMs
    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("should repair nextRunAtMs=0 during maintenance", () => {
    const now = Date.now();

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: 0,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("should clear nextRunAtMs for disabled jobs during maintenance", () => {
    const now = Date.now();
    const futureTime = now + 3600_000;

    const job = createCronSystemEventJob(now, {
      enabled: false, // Disabled
      state: {
        nextRunAtMs: futureTime,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should have cleared nextRunAtMs for disabled job
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it("should clear stuck running markers during maintenance", () => {
    const now = Date.now();
    const stuckTime = now - 3 * 60 * 60_000; // 3 hours ago (> 2 hour threshold)
    const futureTime = now + 3600_000;

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: futureTime,
        runningAtMs: stuckTime, // Stuck running marker
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should have cleared stuck running marker
    expect(job.state.runningAtMs).toBeUndefined();
    // But should NOT have changed nextRunAtMs (it's still future)
    expect(job.state.nextRunAtMs).toBe(futureTime);
  });

  it("isolates schedule errors while filling missing nextRunAtMs", () => {
    const now = Date.now();
    const pastDue = now - 1_000;

    const dueJob: CronJob = {
      id: "due-job",
      name: "due job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "due" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue,
      },
    };

    const malformedJob: CronJob = {
      id: "bad-job",
      name: "bad job",
      enabled: true,
      schedule: { kind: "cron", expr: "not a valid cron", tz: "UTC" },
      payload: { kind: "systemEvent", text: "bad" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        // missing nextRunAtMs
      },
    };

    const state = createMockCronStateForJobs({ jobs: [dueJob, malformedJob], nowMs: now });

    expect(() => recomputeNextRunsForMaintenance(state)).not.toThrow();
    expect(dueJob.state.nextRunAtMs).toBe(pastDue);
    expect(malformedJob.state.nextRunAtMs).toBeUndefined();
    expect(malformedJob.state.scheduleErrorCount).toBe(1);
    expect(malformedJob.state.lastError).toMatch(/^schedule error:/);
  });

  it("recomputes expired slots already executed but keeps never-executed stale slots", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const alreadyExecuted: CronJob = {
      id: "already-executed",
      name: "already executed",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "done" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      state: {
        nextRunAtMs: pastDue,
        lastRunAtMs: pastDue + 1000,
      },
    };

    const neverExecuted: CronJob = {
      id: "never-executed",
      name: "never executed",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "pending" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now - 86400_000 * 2,
      updatedAtMs: now - 86400_000 * 2,
      state: {
        nextRunAtMs: pastDue,
        lastRunAtMs: pastDue - 86400_000,
      },
    };

    const state = createMockCronStateForJobs({
      jobs: [alreadyExecuted, neverExecuted],
      nowMs: now,
    });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });

    expect((alreadyExecuted.state.nextRunAtMs ?? 0) > now).toBe(true);
    expect(neverExecuted.state.nextRunAtMs).toBe(pastDue);
  });

  it("does not advance overdue never-executed jobs when stale running marker is cleared", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const staleRunningAt = now - 3 * 60 * 60_000;

    const job: CronJob = {
      id: "stale-running-overdue",
      name: "stale running overdue",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      state: {
        nextRunAtMs: pastDue,
        runningAtMs: staleRunningAt,
        lastRunAtMs: pastDue - 3600_000,
      },
    };

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true, nowMs: now });

    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("advances overdue already-executed jobs when stale running marker is cleared", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const staleRunningAt = now - 3 * 60 * 60_000;

    const job: CronJob = {
      id: "stale-running-already-executed",
      name: "stale running already executed",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      state: {
        nextRunAtMs: pastDue,
        runningAtMs: staleRunningAt,
        lastRunAtMs: pastDue + 1000,
      },
    };

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true, nowMs: now });

    expect(job.state.runningAtMs).toBeUndefined();
    expect((job.state.nextRunAtMs ?? 0) > now).toBe(true);
  });
});
