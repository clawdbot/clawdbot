import { describe, expect, it, vi } from "vitest";
import { waitForMatrixQaObserverEvent } from "./adapter.runtime.js";
import type { MatrixQaRoomObserver } from "./substrate/sync.js";

function makeObserver(
  waitForOptionalRoomEvent: MatrixQaRoomObserver["waitForOptionalRoomEvent"],
): MatrixQaRoomObserver {
  return {
    prime: vi.fn(async () => "s0"),
    waitForOptionalRoomEvent,
    waitForRoomEvent: vi.fn(),
  };
}

describe("Matrix QA adapter observer recovery", () => {
  it("retries a sync failure only during the explicit transport interruption window", async () => {
    let interrupted = true;
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockRejectedValueOnce(new Error("homeserver unavailable"))
      .mockResolvedValueOnce({ matched: false, since: "s1" });
    const sleepImpl = vi.fn(async () => {
      interrupted = false;
    });

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => interrupted,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        readInterruptionGeneration: () => 1,
        roomId: "!room:matrix.test",
        sleepImpl,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ matched: false, since: "s1" });
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
  });

  it("preserves terminal observer failures outside the interruption window", async () => {
    const failure = new Error("sync failed");
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockRejectedValue(failure);
    const sleepImpl = vi.fn(async () => undefined);

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => false,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        readInterruptionGeneration: () => 0,
        roomId: "!room:matrix.test",
        sleepImpl,
        timeoutMs: 1_000,
      }),
    ).rejects.toBe(failure);
    expect(waitForOptionalRoomEvent).toHaveBeenCalledOnce();
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("retries a poll that started during interruption after readiness closes the window", async () => {
    let interrupted = true;
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockImplementationOnce(async () => {
        interrupted = false;
        throw new Error("stale outage response");
      })
      .mockResolvedValueOnce({ matched: false, since: "s2" });

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => interrupted,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        readInterruptionGeneration: () => 1,
        roomId: "!room:matrix.test",
        sleepImpl: vi.fn(async () => undefined),
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ matched: false, since: "s2" });
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(2);
  });

  it("retries a poll that spans the complete interruption window", async () => {
    let interruptionGeneration = 0;
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockImplementationOnce(async () => {
        // The poll began before restart and rejected only after begin/end both ran.
        interruptionGeneration = 2;
        throw new Error("pre-restart poll rejected after recovery");
      })
      .mockResolvedValueOnce({ matched: false, since: "s3" });

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => false,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        readInterruptionGeneration: () => interruptionGeneration,
        roomId: "!room:matrix.test",
        sleepImpl: vi.fn(async () => undefined),
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ matched: false, since: "s3" });
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(2);
  });
});
