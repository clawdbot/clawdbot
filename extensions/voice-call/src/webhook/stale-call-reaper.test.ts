// Voice Call tests cover stale call reaper plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStaleCallReaper } from "./stale-call-reaper.js";

describe("startStaleCallReaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns null when disabled or non-positive", () => {
    const manager = {
      getActiveCalls: vi.fn(() => []),
      endCall: vi.fn(),
    };

    expect(startStaleCallReaper({ manager })).toBeNull();
    expect(startStaleCallReaper({ manager, staleCallReaperSeconds: 0 })).toBeNull();
  });

  it("reaps stale calls and ignores fresh ones", async () => {
    const endCall = vi.fn(async () => ({ success: true }));
    const manager = {
      getActiveCalls: vi.fn(() => [
        {
          callId: "call-stale",
          startedAt: Date.now() - 61_000,
          state: "active" as const,
        },
        {
          callId: "call-fresh",
          startedAt: Date.now() - 10_000,
          state: "active" as const,
        },
      ]),
      endCall,
    };

    const stop = startStaleCallReaper({
      manager,
      staleCallReaperSeconds: 60,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(endCall).toHaveBeenCalledTimes(1);
    expect(endCall).toHaveBeenCalledWith("call-stale");

    stop?.();
  });

  it("does not overlap stale-call reaps and retries after an unsuccessful attempt settles", async () => {
    let resolveFirstEndCall!: (result: { success: false; error: string }) => void;
    const firstEndCall = new Promise<{ success: false; error: string }>((resolve) => {
      resolveFirstEndCall = resolve;
    });
    const endCall = vi
      .fn()
      .mockImplementationOnce(() => firstEndCall)
      .mockResolvedValue({ success: true });
    const manager = {
      getActiveCalls: vi.fn(() => [
        {
          callId: "call-stale",
          startedAt: Date.now() - 61_000,
          state: "active" as const,
        },
      ]),
      endCall,
    };

    const stop = startStaleCallReaper({
      manager,
      staleCallReaperSeconds: 60,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(endCall).toHaveBeenCalledTimes(1);

    resolveFirstEndCall({ success: false, error: "network" });
    await firstEndCall;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(endCall).toHaveBeenCalledTimes(2);
    expect(endCall).toHaveBeenNthCalledWith(2, "call-stale");

    stop?.();
  });

  it.each(["speaking", "listening"] as const)(
    "does not reap live %s calls without answeredAt",
    async (state) => {
      const endCall = vi.fn(async () => ({ success: true }));
      const manager = {
        getActiveCalls: vi.fn(() => [
          {
            callId: `call-${state}`,
            startedAt: Date.now() - 120_000,
            state,
          },
        ]),
        endCall,
      };

      const stop = startStaleCallReaper({
        manager,
        staleCallReaperSeconds: 60,
      });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(endCall).not.toHaveBeenCalled();

      stop?.();
    },
  );

  it("logs and swallows endCall failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const endCallError = new Error("network");
    const endCall = vi.fn(async () => {
      throw endCallError;
    });
    const manager = {
      getActiveCalls: vi.fn(() => [
        {
          callId: "call-stale",
          startedAt: Date.now() - 61_000,
          state: "active" as const,
        },
      ]),
      endCall,
    };

    const stop = startStaleCallReaper({
      manager,
      staleCallReaperSeconds: 60,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      "[voice-call] Reaper failed to end call call-stale:",
      endCallError,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(endCall).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);

    stop?.();
  });
});
