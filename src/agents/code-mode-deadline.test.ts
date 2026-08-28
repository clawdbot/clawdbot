import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitCodeModeDeadline } from "./code-mode-deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Code Mode execution deadlines", () => {
  it("returns work completed within the shared deadline", async () => {
    await expect(
      awaitCodeModeDeadline({
        operation: async () => "prepared",
        remainingMs: 1_000,
        createTimeoutError: () => new Error("timed out"),
        createAbortError: () => new Error("aborted"),
      }),
    ).resolves.toBe("prepared");
  });

  it("rejects pending preparation when its wall-clock budget expires", async () => {
    vi.useFakeTimers();
    const result = awaitCodeModeDeadline({
      operation: () => new Promise<string>(() => {}),
      remainingMs: 100,
      createTimeoutError: () => new Error("timed out"),
      createAbortError: () => new Error("aborted"),
    });
    const assertion = expect(result).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(100);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects pending preparation immediately when its caller aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = awaitCodeModeDeadline({
      operation: () => new Promise<string>(() => {}),
      remainingMs: 30_000,
      signal: controller.signal,
      createTimeoutError: () => new Error("timed out"),
      createAbortError: () => new Error("aborted"),
    });

    controller.abort();

    await expect(result).rejects.toThrow("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects elapsed deadlines before waiting on preparation", async () => {
    const operation = vi.fn(() => new Promise<string>(() => {}));

    await expect(
      awaitCodeModeDeadline({
        operation,
        remainingMs: -1,
        createTimeoutError: () => new Error("timed out"),
        createAbortError: () => new Error("aborted"),
      }),
    ).rejects.toThrow("timed out");

    expect(operation).not.toHaveBeenCalled();
  });

  it("does not start preparation when its caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(() => new Promise<string>(() => {}));

    await expect(
      awaitCodeModeDeadline({
        operation,
        remainingMs: 1_000,
        signal: controller.signal,
        createTimeoutError: () => new Error("timed out"),
        createAbortError: () => new Error("aborted"),
      }),
    ).rejects.toThrow("aborted");

    expect(operation).not.toHaveBeenCalled();
  });
});
