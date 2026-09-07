// Matrix tests cover monitor task-runner idle drain behavior.
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

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
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies RuntimeLogger;
  const logVerboseMessage = vi.fn();
  const runner = createMatrixMonitorTaskRunner({
    logger,
    logVerboseMessage,
  });
  return { logger, logVerboseMessage, runner };
}

describe("createMatrixMonitorTaskRunner waitForIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when no tasks are in flight", async () => {
    const { logger, logVerboseMessage, runner } = createHarness();

    await expect(runner.waitForIdle()).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logVerboseMessage).not.toHaveBeenCalled();
  });

  it("returns when no in-flight task settles within the idle window", async () => {
    vi.useFakeTimers();
    const { logger, logVerboseMessage, runner } = createHarness();
    void runner.runDetachedTask("join", () => new Promise(() => {}));

    const idle = runner.waitForIdle();
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS);
    await expect(idle).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      "matrix waitForIdle timed out",
      expect.objectContaining({ idleTimeoutMs: WAIT_FOR_IDLE_TIMEOUT_MS, remaining: 1 }),
    );
    expect(logVerboseMessage).toHaveBeenCalledWith(
      expect.stringContaining(`${WAIT_FOR_IDLE_TIMEOUT_MS}ms`),
    );
  });

  it("waits for a task that settles before the idle timeout", async () => {
    const { logger, logVerboseMessage, runner } = createHarness();
    const pending = deferredTask();
    let settled = false;
    void runner.runDetachedTask("room", async () => {
      await pending.promise;
      settled = true;
    });

    const idle = runner.waitForIdle();
    expect(settled).toBe(false);
    pending.resolve();
    await expect(idle).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logVerboseMessage).not.toHaveBeenCalled();
  });

  it("resets the idle timer when a task settles and another is added", async () => {
    vi.useFakeTimers();
    const { logger, logVerboseMessage, runner } = createHarness();
    const first = deferredTask();
    const second = deferredTask();
    void runner.runDetachedTask("first", () => first.promise);

    const idle = runner.waitForIdle();
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS - 5_000);
    first.resolve();
    void runner.runDetachedTask("second", () => second.promise);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS - 5_000);
    expect(logger.warn).not.toHaveBeenCalled();

    second.resolve();
    await expect(idle).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logVerboseMessage).not.toHaveBeenCalled();
  });
});
