import { afterEach, describe, expect, it, vi } from "vitest";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";

function deferredTask() {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred task callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("drainPendingToolTasks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles immediately when there are no pending tasks", async () => {
    await expect(drainPendingToolTasks({ tasks: new Set() })).resolves.toEqual({
      kind: "settled",
    });
  });

  it("waits for all pending tasks to settle", async () => {
    const first = deferredTask();
    const second = deferredTask();
    const tasks = new Set([first.promise, second.promise]);

    const drain = drainPendingToolTasks({ tasks, idleTimeoutMs: 1_000 });
    first.resolve();
    await flushPromises();
    expect(tasks.size).toBe(1);
    second.resolve();

    await expect(drain).resolves.toEqual({ kind: "settled" });
    expect(tasks.size).toBe(0);
  });

  it("resets the idle timeout after each completed task", async () => {
    vi.useFakeTimers();
    const first = deferredTask();
    const second = deferredTask();
    const onTimeout = vi.fn();
    const tasks = new Set([first.promise, second.promise]);

    const drain = drainPendingToolTasks({ tasks, idleTimeoutMs: 100, onTimeout });

    await vi.advanceTimersByTimeAsync(80);
    first.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(80);
    expect(onTimeout).not.toHaveBeenCalled();

    second.resolve();
    await expect(drain).resolves.toEqual({ kind: "settled" });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("returns timeout when no pending task settles before the idle window", async () => {
    vi.useFakeTimers();
    const stuck = deferredTask();
    const onTimeout = vi.fn();
    const tasks = new Set([stuck.promise]);

    const drain = drainPendingToolTasks({ tasks, idleTimeoutMs: 100, onTimeout });
    await vi.advanceTimersByTimeAsync(100);

    await expect(drain).resolves.toEqual({ kind: "timeout", remaining: 1 });
    expect(onTimeout).toHaveBeenCalledWith(
      "pending tool tasks made no progress within 100ms; proceeding with 1 task(s) still pending to avoid session deadlock",
    );
    expect(tasks.size).toBe(1);
  });

  it("treats rejected tasks as drained progress", async () => {
    const failed = deferredTask();
    const later = deferredTask();
    const tasks = new Set([failed.promise, later.promise]);

    const drain = drainPendingToolTasks({ tasks, idleTimeoutMs: 1_000 });
    failed.reject(new Error("send failed"));
    await flushPromises();
    expect(tasks.size).toBe(1);
    later.resolve();

    await expect(drain).resolves.toEqual({ kind: "settled" });
  });
});
