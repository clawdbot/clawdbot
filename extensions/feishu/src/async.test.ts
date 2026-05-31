import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { raceWithTimeoutAndAbort, waitForAbortableDelay } from "./async.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("raceWithTimeoutAndAbort", () => {
  it("normalizes oversized timeouts before arming the watchdog", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    await raceWithTimeoutAndAbort(Promise.resolve("ok"), {
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});

describe("waitForAbortableDelay", () => {
  it("resolves false immediately when already aborted", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    abortController.abort();

    await expect(waitForAbortableDelay(60_000, abortController.signal)).resolves.toBe(false);
  });

  it("resolves false immediately when aborted during backoff", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();

    const delay = waitForAbortableDelay(60_000, abortController.signal);
    abortController.abort();

    await expect(delay).resolves.toBe(false);
  });

  it("resolves true after the full delay when not aborted", async () => {
    vi.useFakeTimers();

    const delay = waitForAbortableDelay(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(delay).resolves.toBe(true);
  });

  it("normalizes oversized delays before arming the timer", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: () => void) => {
        queueMicrotask(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      });
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    const delay = waitForAbortableDelay(Number.MAX_SAFE_INTEGER);

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    await expect(delay).resolves.toBe(true);
  });
});
