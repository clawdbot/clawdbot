// Cron rearm tests cover timer rearming while scheduled jobs are already running.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createNoopLogger, createCronStoreHarness } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();

function createDueRecurringJob(params: {
  id: string;
  nowMs: number;
  nextRunAtMs: number;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "every", everyMs: 5 * 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: params.nextRunAtMs },
  };
}

describe("CronService - timer re-arm when running (#12025)", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("arms a watchdog timer while a timer tick is still executing", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        createDueRecurringJob({
          id: "long-running-job",
          nowMs: now,
          nextRunAtMs: now,
        }),
      ],
    });
    const runIsolatedAgentJob = vi.fn(async () => await deferredRun.promise);

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    let settled = false;
    const timerPromise = onTimer(state);
    void timerPromise.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);
    expect(state.running).toBe(true);
    expect(
      timeoutSpy.mock.results.some(
        (result) => result.type === "return" && result.value === state.timer,
      ),
    ).toBe(true);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    expect(delays).toContain(60_000);

    deferredRun.resolve({ status: "ok", summary: "done" });
    await timerPromise;
    expect(state.running).toBe(false);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });
});
