import { afterEach, describe, expect, it, vi } from "vitest";
import { raceWithTimeout } from "./race-with-timeout.js";

interface VoiceSendResult {
  channel: string;
  error?: string;
  messageId?: string;
}

describe("raceWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the voice-send timeout after delivery resolves", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(
      raceWithTimeout<VoiceSendResult>(
        async () => ({ channel: "qqbot", messageId: "voice-1" }),
        45_000,
        () => ({ channel: "qqbot", error: "Voice send timed out and was skipped" }),
      ),
    ).resolves.toEqual({ channel: "qqbot", messageId: "voice-1" });

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the voice-send timeout after delivery rejects", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const failure = new Error("voice send failed");

    await expect(
      raceWithTimeout<VoiceSendResult>(
        async () => {
          throw failure;
        },
        45_000,
        () => ({ channel: "qqbot", error: "Voice send timed out and was skipped" }),
      ),
    ).rejects.toBe(failure);

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks late delivery settlement after the timeout wins", async () => {
    vi.useFakeTimers();
    let resolveDelivery: (result: VoiceSendResult) => void = () => {};
    const delivery = new Promise<VoiceSendResult>((resolve) => {
      resolveDelivery = resolve;
    });
    let lateResult: Promise<VoiceSendResult> | undefined;

    const result = raceWithTimeout<VoiceSendResult>(
      (state) => {
        lateResult = delivery.then((value) =>
          state.timedOut
            ? { channel: "qqbot", error: "Voice send completed after timeout (suppressed)" }
            : value,
        );
        return lateResult;
      },
      45_000,
      () => ({ channel: "qqbot", error: "Voice send timed out and was skipped" }),
    );

    await vi.advanceTimersByTimeAsync(45_000);
    await expect(result).resolves.toEqual({
      channel: "qqbot",
      error: "Voice send timed out and was skipped",
    });

    resolveDelivery({ channel: "qqbot", messageId: "voice-late" });
    await expect(lateResult).resolves.toEqual({
      channel: "qqbot",
      error: "Voice send completed after timeout (suppressed)",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
