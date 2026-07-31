import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineLogger } from "../types.js";
import { withRetry } from "./retry.js";

const mocks = vi.hoisted(() => ({
  sleep: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({ sleep: mocks.sleep }));

function createLogger(): EngineLogger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

beforeEach(() => {
  mocks.sleep.mockClear();
});

describe("withRetry", () => {
  it("uses the shared runner without changing exponential schedules", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce("ok");
    const logger = createLogger();

    try {
      const promise = withRetry(
        operation,
        { maxRetries: 2, baseDelayMs: 100, backoff: "exponential" },
        undefined,
        logger,
      );
      await vi.advanceTimersByTimeAsync(99);
      expect(operation).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(operation).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(199);
      expect(operation).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(3);
      expect(logger.debug).toHaveBeenNthCalledWith(
        1,
        "[qqbot:retry] Attempt 1 failed, retrying in 100ms: first",
      );
      expect(logger.debug).toHaveBeenNthCalledWith(
        2,
        "[qqbot:retry] Attempt 2 failed, retrying in 200ms: second",
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps fixed retry schedules flat", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce("ok");

    try {
      const promise = withRetry(operation, {
        maxRetries: 2,
        baseDelayMs: 75,
        backoff: "fixed",
      });
      await vi.advanceTimersByTimeAsync(75);
      expect(operation).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(75);
      await expect(promise).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("preserves the policy's zero-based attempt index", async () => {
    const shouldRetry = vi.fn(() => false);
    await expect(
      withRetry(
        async () => {
          throw new Error("stop");
        },
        {
          maxRetries: 2,
          baseDelayMs: 100,
          backoff: "fixed",
          shouldRetry,
        },
      ),
    ).rejects.toThrow("stop");
    expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 0);
    expect(mocks.sleep).not.toHaveBeenCalled();
  });

  it("does not restart a persistent loop after its terminal failure", async () => {
    const persistentTrigger = Object.assign(new Error("processing"), { bizCode: 42 });
    const terminal = new Error("permission denied");
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(persistentTrigger)
      .mockRejectedValueOnce(terminal);

    await expect(
      withRetry(
        operation,
        { maxRetries: 2, baseDelayMs: 100, backoff: "fixed" },
        {
          timeoutMs: 1_000,
          intervalMs: 10,
          shouldPersistRetry: (error) =>
            "bizCode" in error && (error as { bizCode?: number }).bizCode === 42,
        },
      ),
    ).rejects.toBe(terminal);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(mocks.sleep).not.toHaveBeenCalled();
  });
});
