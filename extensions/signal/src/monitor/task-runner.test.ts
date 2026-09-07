// Signal tests cover monitor task-runner idle drain behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignalMonitorTaskRunner } from "./task-runner.js";

function deferredTask() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred task resolver to be initialized");
  }
  return { promise, resolve };
}

const WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

function createHarness() {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
  const runner = createSignalMonitorTaskRunner(runtime);
  return { runtime, runner };
}

describe("createSignalMonitorTaskRunner waitForIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when no tasks are in flight", async () => {
    const { runtime, runner } = createHarness();

    await expect(runner.waitForIdle()).resolves.toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("returns when no in-flight task settles within the idle window", async () => {
    vi.useFakeTimers();
    const { runtime, runner } = createHarness();
    void runner.runTask(() => new Promise(() => {}));

    let resolved = false;
    const idle = runner.waitForIdle().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS);
    expect(resolved).toBe(true);
    await expect(idle).resolves.toBeUndefined();

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`${WAIT_FOR_IDLE_TIMEOUT_MS}ms`),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("1 task"));
  });

  it("waits for a task that settles before the idle timeout", async () => {
    const { runtime, runner } = createHarness();
    const pending = deferredTask();
    let settled = false;
    void runner.runTask(async () => {
      await pending.promise;
      settled = true;
    });

    const idle = runner.waitForIdle();
    expect(settled).toBe(false);
    pending.resolve();
    await expect(idle).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("resets the idle timer when a task settles and another is added", async () => {
    vi.useFakeTimers();
    const { runtime, runner } = createHarness();
    const first = deferredTask();
    const second = deferredTask();
    void runner.runTask(() => first.promise);

    const idle = runner.waitForIdle();
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS - 5_000);
    first.resolve();
    void runner.runTask(() => second.promise);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS - 5_000);
    expect(runtime.error).not.toHaveBeenCalled();

    second.resolve();
    await expect(idle).resolves.toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
  });
});
