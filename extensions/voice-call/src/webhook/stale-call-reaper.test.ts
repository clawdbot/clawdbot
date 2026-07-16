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

    expect(startStaleCallReaper({ manager: manager as never })).toBeNull();
    expect(
      startStaleCallReaper({ manager: manager as never, staleCallReaperSeconds: 0 }),
    ).toBeNull();
  });

  it("reaps stale calls and ignores fresh ones", async () => {
    const endCall = vi.fn(async () => {});
    const manager = {
      getActiveCalls: vi.fn(() => [
        {
          callId: "call-stale",
          startedAt: Date.now() - 61_000,
          state: "active",
        },
        {
          callId: "call-fresh",
          startedAt: Date.now() - 10_000,
          state: "active",
        },
      ]),
      endCall,
    };

    const stop = startStaleCallReaper({
      manager: manager as never,
      staleCallReaperSeconds: 60,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(endCall).toHaveBeenCalledTimes(1);
    expect(endCall).toHaveBeenCalledWith("call-stale");

    stop?.();
  });

  it("logs and swallows endCall failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = {
      getActiveCalls: vi.fn(() => [
        {
          callId: "call-stale",
          startedAt: Date.now() - 61_000,
          state: "active",
        },
      ]),
      endCall: vi.fn(async () => {
        throw new Error("network");
      }),
    };

    const stop = startStaleCallReaper({
      manager: manager as never,
      staleCallReaperSeconds: 60,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      "[voice-call] Reaper failed to end call call-stale:",
      expect.any(Error),
    );

    stop?.();
  });
});
