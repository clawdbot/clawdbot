import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { raceWithTimeout, withAbortTimeout } from "./timeouts.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("discord monitor timeouts", () => {
  it("caps raceWithTimeout timers before arming the watchdog", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    await expect(
      raceWithTimeout({
        promise: Promise.resolve("ok"),
        timeoutMs: Number.MAX_SAFE_INTEGER,
        onTimeout: () => "timeout",
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("caps withAbortTimeout timers before arming the watchdog", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    await expect(
      withAbortTimeout({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        createTimeoutError: () => new Error("timed out"),
        run: async () => "ok",
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
