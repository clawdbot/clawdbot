import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "./command-queue.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import type { CommandQueueTaskDeadline } from "./command-queue.types.js";

const lane = "runtime-deadline-test";
const finishers: Array<() => void> = [];

function enqueueOwnedTask(initialDeadline: CommandQueueTaskDeadline, initiallyAborted = false) {
  const finish = createDeferred();
  finishers.push(finish.resolve);
  const abort = new AbortController();
  const release = new AbortController();
  if (initiallyAborted) {
    abort.abort();
  }
  const unsubscribe = vi.fn();
  let progressAtMs = Date.now();
  let publish: (deadline: CommandQueueTaskDeadline | undefined) => void = () => {
    throw new Error("deadline subscription is not active");
  };
  const task = enqueueCommandInLane(lane, () => finish.promise, {
    taskTimeoutMs: 25,
    taskTimeoutProgressAtMs: () => progressAtMs,
    taskTimeoutAbortSignal: abort.signal,
    taskTimeoutAbortGraceMs: 5,
    taskTimeoutReleaseSignal: release.signal,
    taskTimeoutSubscribe: (onDeadline) => {
      publish = onDeadline;
      onDeadline(initialDeadline);
      return unsubscribe;
    },
  });
  const outcome = task.then(
    () => ({ status: "completed" as const }),
    (error: unknown) => ({ status: "failed" as const, error }),
  );
  return {
    abort,
    release,
    finish: finish.resolve,
    outcome,
    unsubscribe,
    publish: (deadline: CommandQueueTaskDeadline | undefined) => publish(deadline),
    progress: () => {
      progressAtMs = Date.now();
    },
  };
}

beforeEach(() => {
  resetCommandQueueStateForTest();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-20T12:00:00Z"));
});

afterEach(async () => {
  for (const finish of finishers.splice(0)) {
    finish();
  }
  await vi.advanceTimersByTimeAsync(0);
  resetCommandQueueStateForTest();
  vi.useRealTimers();
});

describe("command lane owner deadlines", () => {
  it("replaces idle timing with an absolute deadline that progress cannot extend", async () => {
    const owner = enqueueOwnedTask({ kind: "bounded", deadlineAtMs: Date.now() + 100 });
    const next = vi.fn(async () => "next");
    const queued = enqueueCommandInLane(lane, next);
    await vi.advanceTimersByTimeAsync(50);
    owner.progress();
    await vi.advanceTimersByTimeAsync(49);
    expect(next).not.toHaveBeenCalled();
    expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 1 });
    await vi.advanceTimersByTimeAsync(1);
    await expect(owner.outcome).resolves.toMatchObject({
      status: "failed",
      error: {
        name: "CommandLaneTaskTimeoutError",
        message: expect.stringContaining("owner deadline"),
      },
    });
    await expect(queued).resolves.toBe("next");
    expect(owner.unsubscribe).toHaveBeenCalledOnce();
  });

  it("lets unlimited execution hand off to bounded terminal settlement", async () => {
    const owner = enqueueOwnedTask({ kind: "unlimited" });
    await vi.advanceTimersByTimeAsync(49 * 60 * 60 * 1000);
    expect(getCommandLaneSnapshot(lane).activeCount).toBe(1);
    owner.publish({ kind: "bounded", deadlineAtMs: Date.now() + 120_000 });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(getCommandLaneSnapshot(lane).activeCount).toBe(1);
    owner.finish();
    await expect(owner.outcome).resolves.toEqual({ status: "completed" });
    owner.publish({ kind: "bounded", deadlineAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(1);
    expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores ordinary idle recovery after the runtime releases deadline ownership", async () => {
    const owner = enqueueOwnedTask({ kind: "unlimited" });
    await vi.advanceTimersByTimeAsync(1_000);
    owner.progress();
    owner.publish(undefined);
    await vi.advanceTimersByTimeAsync(24);
    expect(getCommandLaneSnapshot(lane).activeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(owner.outcome).resolves.toMatchObject({
      status: "failed",
      error: {
        name: "CommandLaneTaskTimeoutError",
        message: expect.stringContaining("no progress for 25ms"),
      },
    });
  });

  it("does not let a late deadline update replace an accepted abort grace", async () => {
    const owner = enqueueOwnedTask({ kind: "unlimited" });
    owner.abort.abort();
    owner.publish({ kind: "unlimited" });
    await vi.advanceTimersByTimeAsync(4);
    expect(getCommandLaneSnapshot(lane).activeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(owner.outcome).resolves.toMatchObject({
      status: "failed",
      error: {
        name: "CommandLaneTaskTimeoutError",
        message: expect.stringContaining("abort grace 5ms"),
      },
    });
  });

  it.each([false, true])(
    "honors immediate release when initially aborted=%s",
    async (initiallyAborted) => {
      const owner = enqueueOwnedTask({ kind: "unlimited" }, initiallyAborted);
      owner.release.abort();
      await expect(owner.outcome).resolves.toMatchObject({
        status: "failed",
        error: {
          name: "CommandLaneTaskTimeoutError",
          message: expect.stringContaining("lane release requested"),
        },
      });
      expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
    },
  );
});
