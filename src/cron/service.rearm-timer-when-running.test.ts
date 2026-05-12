import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoopLogger,
  createCronStoreHarness,
  createRunningCronServiceState,
} from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.js";
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

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function latestTimeoutHandle(timeoutSpy: ReturnType<typeof vi.spyOn>) {
  const result = timeoutSpy.mock.results.at(-1);
  if (!result || result.type !== "return") {
    throw new Error("Expected setTimeout to return a timer handle");
  }
  return result.value;
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

  it("re-arms the timer when onTimer is called while state.running is true", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");

    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      jobs: [
        createDueRecurringJob({
          id: "recurring-job",
          nowMs: now,
          nextRunAtMs: now + 5 * 60_000,
        }),
      ],
    });

    // Before the fix in #12025, this would return without re-arming,
    // silently killing the scheduler.
    await onTimer(state);

    // The timer must be re-armed so the scheduler continues ticking,
    // with a fixed 60s delay to avoid hot-looping.
    expect(timeoutSpy).toHaveBeenCalled();
    expect(state.timer).toBe(latestTimeoutHandle(timeoutSpy));
    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    expect(delays).toContain(60_000);

    // state.running should still be true (onTimer bailed out, didn't
    // touch it — the original caller's finally block handles that).
    expect(state.running).toBe(true);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });

  it("arms a watchdog timer while a timer tick is still executing", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            createDueRecurringJob({
              id: "long-running-job",
              nowMs: now,
              nextRunAtMs: now,
            }),
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => await deferredRun.promise),
    });

    let settled = false;
    const timerPromise = onTimer(state);
    void timerPromise.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(state.running).toBe(true);
    expect(state.timer).toBe(latestTimeoutHandle(timeoutSpy));

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
