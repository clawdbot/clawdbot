// Timer tight-loop tests cover cron service guards against immediate rearm loops.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopLogger, createCronStoreHarness } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { armTimer } from "./service/timer.js";
import { onTimer } from "./service/timer.test-support.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-tight-loop-" });

/**
 * Create a cron job that is past-due AND has a stuck `runningAtMs` marker.
 * This combination causes `findDueJobs` to return `[]` (blocked by
 * `runningAtMs`) while `nextWakeAtMs` still returns the past-due timestamp,
 * which before the fix resulted in a `setTimeout(0)` tight loop.
 */
function createStuckPastDueJob(params: { id: string; nowMs: number; pastDueMs: number }): CronJob {
  const pastDueAt = params.nowMs - params.pastDueMs;
  return {
    id: params.id,
    name: "stuck-job",
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: pastDueAt - 60_000,
    updatedAtMs: pastDueAt - 60_000,
    schedule: { kind: "cron", expr: "*/15 * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "monitor" },
    delivery: { mode: "none" },
    state: {
      nextRunAtMs: pastDueAt,
      // Stuck: set from a previous execution that was interrupted.
      // Not yet old enough for STUCK_RUN_MS (2 h) to clear it.
      runningAtMs: pastDueAt + 1,
    },
  };
}

describe("CronService - armTimer tight loop prevention", () => {
  function extractTimeoutDelays(timeoutSpy: ReturnType<typeof vi.spyOn>) {
    const calls = timeoutSpy.mock.calls as Array<[unknown, unknown, ...unknown[]]>;
    return calls
      .map(([, delay]: [unknown, unknown, ...unknown[]]) => delay)
      .filter((d: unknown): d is number => typeof d === "number");
  }

  function latestTimeoutHandle(timeoutSpy: ReturnType<typeof vi.spyOn>) {
    const result = timeoutSpy.mock.results.at(-1);
    if (!result || result.type !== "return") {
      throw new Error("Expected setTimeout to return a timer handle");
    }
    return result.value;
  }

  function createTimerState(params: {
    storePath: string;
    now: number;
    runIsolatedAgentJob?: () => Promise<{ status: "ok" }>;
  }) {
    return createCronServiceState({
      storePath: params.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => params.now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob:
        params.runIsolatedAgentJob ?? vi.fn().mockResolvedValue({ status: "ok" }),
    });
  }

  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("enforces a minimum delay when the next wake time is in the past", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const now = Date.parse("2026-02-28T12:32:00.000Z");
    const pastDueMs = 17 * 60 * 1000; // 17 minutes past due

    const state = createTimerState({
      storePath: "/tmp/test-cron/jobs.json",
      now,
    });
    state.store = {
      version: 1,
      jobs: [createStuckPastDueJob({ id: "monitor", nowMs: now, pastDueMs })],
    };

    armTimer(state);

    expect(state.timer).toBe(latestTimeoutHandle(timeoutSpy));
    const delays = extractTimeoutDelays(timeoutSpy);

    // Before the fix, delay would be 0 (tight loop).
    // After the fix, delay must be >= MIN_REFIRE_GAP_MS (2000 ms).
    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(2_000);
    }

    timeoutSpy.mockRestore();
  });

  it("reads enabled and collection length only during one future-wake traversal", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const now = Date.parse("2026-02-28T12:32:00.000Z");

    const state = createTimerState({
      storePath: "/tmp/test-cron/jobs.json",
      now,
    });
    const job: CronJob = {
      id: "future-job",
      name: "future-job",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "cron", expr: "*/15 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
      delivery: { mode: "none" },
      state: { nextRunAtMs: now + 10_000 },
    };
    let enabledReads = 0;
    Object.defineProperty(job, "enabled", {
      configurable: true,
      get: () => {
        enabledReads += 1;
        if (enabledReads > 1) {
          throw new Error("enabled read more than once");
        }
        return true;
      },
    });
    let lengthReads = 0;
    const jobs = new Proxy([job], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          if (lengthReads > target.length + 1) {
            throw new Error("jobs.length read after iteration");
          }
        }
        return Reflect.get(target, property, receiver);
      },
    });
    state.store = {
      version: 1,
      jobs,
    };

    try {
      armTimer(state);

      expect(enabledReads).toBe(1);
      expect(lengthReads).toBe(2);
      expect(state.timer).toBe(latestTimeoutHandle(timeoutSpy));
      expect(extractTimeoutDelays(timeoutSpy)).toContain(10_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("keeps a maintenance wake armed when enabled jobs have no nextRunAtMs", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const now = Date.parse("2026-02-28T12:32:00.000Z");

    const state = createTimerState({
      storePath: "/tmp/test-cron/jobs.json",
      now,
    });
    const job: CronJob = {
      id: "missing-next-run",
      name: "missing-next-run",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: now - 60_000,
      updatedAtMs: now - 30_000,
      schedule: { kind: "cron", expr: "*/15 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
      delivery: { mode: "none" },
      state: {
        lastRunStatus: "error",
        lastRunAtMs: now - 45_000,
        lastError: "provider overloaded",
      },
    };
    const jobs = [job];
    const filterSpy = vi.spyOn(jobs, "filter");
    state.store = {
      version: 1,
      jobs,
    };

    try {
      armTimer(state);

      expect(state.timer).toBe(latestTimeoutHandle(timeoutSpy));
      expect(extractTimeoutDelays(timeoutSpy)).toContain(60_000);
      expect(filterSpy).not.toHaveBeenCalled();
      expect(state.store.jobs).toEqual([job]);
      expect(state.store.jobs[0]).toBe(job);
      expect(job.state).toEqual({
        lastRunStatus: "error",
        lastRunAtMs: now - 45_000,
        lastError: "provider overloaded",
      });
      expect(noopLogger.debug).toHaveBeenLastCalledWith(
        { jobCount: 1, enabledCount: 1, withNextRun: 0, delayMs: 60_000 },
        "cron: timer armed for maintenance recheck",
      );
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("keeps a maintenance wake armed for legacy jobs that omit enabled", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const now = Date.parse("2026-02-28T12:32:00.000Z");

    const state = createTimerState({
      storePath: "/tmp/test-cron/jobs.json",
      now,
    });
    // Legacy stores predate the `enabled` flag; isJobEnabled treats the
    // absent value as enabled, so the job is still runnable.
    const job = {
      id: "legacy-no-enabled",
      name: "legacy-no-enabled",
      deleteAfterRun: false,
      createdAtMs: now - 60_000,
      updatedAtMs: now - 30_000,
      schedule: { kind: "cron", expr: "*/15 * * * *" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
      delivery: { mode: "none" },
      state: {
        lastRunStatus: "error",
        lastRunAtMs: now - 45_000,
        lastError: "provider overloaded",
      },
    } as unknown as CronJob;
    state.store = {
      version: 1,
      jobs: [job],
    };

    try {
      armTimer(state);

      expect(state.timer).toBe(latestTimeoutHandle(timeoutSpy));
      expect(extractTimeoutDelays(timeoutSpy)).toContain(60_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("breaks the onTimer→armTimer hot-loop with stuck runningAtMs", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-28T12:32:00.000Z");
    const pastDueMs = 17 * 60 * 1000;

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createStuckPastDueJob({ id: "monitor", nowMs: now, pastDueMs })],
    });

    const state = createTimerState({
      storePath: store.storePath,
      now,
    });

    // Simulate the onTimer path: it will find no runnable jobs (blocked by
    // runningAtMs) and re-arm the timer in its finally block.
    await onTimer(state);

    expect(state.running).toBe(false);
    expect(state.timer).toBe(latestTimeoutHandle(timeoutSpy));

    // The re-armed timer must NOT use delay=0. It should use at least
    // MIN_REFIRE_GAP_MS to prevent the hot-loop.
    const allDelays = extractTimeoutDelays(timeoutSpy);

    // The last setTimeout call is from the finally→armTimer path.
    const lastDelay = allDelays[allDelays.length - 1];
    expect(lastDelay).toBeGreaterThanOrEqual(2_000);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });
});
