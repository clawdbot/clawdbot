import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { startHeartbeatRunner } from "../../infra/heartbeat-runner.js";
import {
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
  type HeartbeatWakeHandler,
} from "../../infra/heartbeat-wake.js";
import {
  drainSystemEventEntries,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:main";
const ran = { status: "ran", durationMs: 1 } as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
});
afterEach(async () => {
  setHeartbeatWakeHandler(async () => ran);
  await vi.advanceTimersByTimeAsync(250);
  setHeartbeatWakeHandler(null);
  resetSystemEventsForTest();
  vi.useRealTimers();
});

function createHarness(handler: HeartbeatWakeHandler) {
  setHeartbeatWakeHandler(handler);
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: path.join(tempDirs.make("cron-wake-owner-"), "jobs.json"),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    nowMs: () => Date.now(),
    enqueueSystemEvent: (text, opts) => {
      const remove = enqueueSystemEventWithReceipt(text, {
        sessionKey,
        contextKey: opts?.contextKey,
      });
      return remove ? { accepted: true, remove } : { accepted: false };
    },
    requestHeartbeat: vi.fn(),
    requestHeartbeatAndWait: (wake, lifecycle) =>
      requestHeartbeatAndWait({ ...wake, sessionKey, coalesceMs: 0 }, lifecycle),
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  const run = (id = "reminder", signal?: AbortSignal) => {
    const job: CronJob = {
      id,
      name: id,
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "at", at: new Date(Date.now()).toISOString() },
      payload: { kind: "systemEvent", text: id },
      sessionTarget: "main",
      wakeMode: "now",
      state: {},
    };
    return executeJobCore(state, job, signal);
  };
  return { state, run };
}

it("coalesces two main jobs and settles both only after their shared turn", async () => {
  const release = createDeferred();
  const observed: string[][] = [];
  const handler = vi.fn(async () => {
    observed.push(drainSystemEventEntries(sessionKey).map((event) => event.text));
    await release.promise;
    return ran;
  });
  const { run } = createHarness(handler);
  let finished = false;
  const pending = Promise.all([run("first"), run("second")]).then((results) => {
    finished = true;
    return results;
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([["first", "second"]]);
    expect(finished).toBe(false);
  } finally {
    release.resolve();
  }
  await expect(pending).resolves.toEqual([
    { status: "ok", summary: "first" },
    { status: "ok", summary: "second" },
  ]);
});

it.each(["preempted", "requests-in-flight"] as const)(
  "waits through %s without shortening the queue's retry deadline",
  async (reason) => {
    const handler = vi
      .fn<HeartbeatWakeHandler>()
      .mockResolvedValueOnce({
        status: "skipped",
        reason,
        ...(reason === "requests-in-flight" ? { retryAtMs: Date.now() + 60_000 } : {}),
      })
      .mockImplementation(async () => {
        drainSystemEventEntries(sessionKey);
        return ran;
      });
    const { run } = createHarness(handler);
    let finished = false;
    const pending = run().then((result) => {
      finished = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: "ok" });
    expect(handler).toHaveBeenCalledTimes(2);
  },
);

it.each([
  { reason: "requests-in-flight", retryDelay: 180_000 },
  { reason: "cron-in-progress", retryDelay: 1_000 },
])(
  "detaches the cron waiter while preserving $reason work and its deadline",
  async ({ reason, retryDelay }) => {
    const handler = vi
      .fn<HeartbeatWakeHandler>()
      .mockResolvedValueOnce({
        status: "skipped",
        reason,
        retryAtMs: Date.now() + retryDelay,
      })
      .mockImplementation(async () => {
        drainSystemEventEntries(sessionKey);
        return ran;
      });
    const { state, run } = createHarness(handler);
    const pending = run();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ status: "ok", summary: "reminder" });
    expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
    expect(handler.mock.calls[0]?.[0].heartbeat).toEqual({ target: "last" });
    expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual(["reminder"]);
    await vi.advanceTimersByTimeAsync(retryDelay - 1);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(peekSystemEventEntries(sessionKey)).toHaveLength(0);
  },
);

it("does not spend the busy budget while the model is executing", async () => {
  const release = createDeferred();
  const { run } = createHarness(async () => {
    await release.promise;
    return ran;
  });
  let finished = false;
  const pending = run().then((result) => {
    finished = true;
    return result;
  });
  try {
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    expect(finished).toBe(false);
  } finally {
    release.resolve();
  }
  await expect(pending).resolves.toMatchObject({ status: "ok" });
});

it.each([false, true])("removes only the cancelled job's event, retrying=%s", async (retrying) => {
  const observed: string[] = [];
  let calls = 0;
  const { run } = createHarness(async () => {
    if (retrying && ++calls === 1) {
      return { status: "skipped", reason: "requests-in-flight" };
    }
    observed.push(...drainSystemEventEntries(sessionKey).map((event) => event.text));
    return ran;
  });
  enqueueSystemEventWithReceipt("unrelated", { sessionKey, contextKey: "other" });
  const controller = new AbortController();
  const pending = run("cancelled", controller.signal);
  if (retrying) {
    await vi.advanceTimersByTimeAsync(0);
  }
  controller.abort();
  await expect(pending).resolves.toMatchObject({ status: "error" });
  expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual(["unrelated"]);
  await vi.advanceTimersByTimeAsync(retrying ? 1_000 : 0);
  expect(observed).toEqual(["unrelated"]);
});

it("removes only the failed job's event after terminal wake failure", async () => {
  const { run } = createHarness(async () => ({ status: "failed", reason: "runner refused" }));
  enqueueSystemEventWithReceipt("unrelated", { sessionKey, contextKey: "other" });
  const pending = run();
  await vi.advanceTimersByTimeAsync(0);
  await expect(pending).resolves.toMatchObject({ status: "error", error: "runner refused" });
  expect(peekSystemEventEntries(sessionKey).map((event) => event.text)).toEqual(["unrelated"]);
});

it("applies the canonical immediate flood guard to main cron wakes", async () => {
  const runOnce = vi.fn(async () => {
    drainSystemEventEntries(sessionKey);
    return ran;
  });
  const { run } = createHarness(async () => ran);
  const runner = startHeartbeatRunner({
    cfg: { agents: { defaults: { heartbeat: { every: "0m" } } } },
    runOnce,
  });
  try {
    for (let index = 0; index < 5; index++) {
      const pending = run(`event-${index}`);
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toMatchObject({ status: "ok" });
    }
    let finished = false;
    const pending = run("sixth").then((result) => {
      finished = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runOnce).toHaveBeenCalledTimes(5);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: "ok" });
    expect(runOnce).toHaveBeenCalledTimes(6);
  } finally {
    runner.stop();
  }
});

it("hands off at the original busy budget after repeated retry deadlines", async () => {
  const handler = vi.fn<HeartbeatWakeHandler>().mockImplementation(async () => ({
    status: "skipped",
    reason: "requests-in-flight",
    retryAtMs: Date.now() + 60_000,
  }));
  const { run } = createHarness(handler);
  let finished = false;
  const pending = run().then((result) => {
    finished = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(119_999);
  expect(handler).toHaveBeenCalledTimes(2);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ status: "ok" });
  expect(handler).toHaveBeenCalledTimes(3);
  handler.mockImplementation(async () => {
    drainSystemEventEntries(sessionKey);
    return ran;
  });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(handler).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(handler).toHaveBeenCalledTimes(4);
  expect(peekSystemEventEntries(sessionKey)).toHaveLength(0);
});
