import { describe, expect, it, vi } from "vitest";
import { MeetingNodeAudioPullWaiters } from "./node-audio-pull-waiters.js";

describe("MeetingNodeAudioPullWaiters", () => {
  it("removes a pull waiter when its timeout wins", async () => {
    vi.useFakeTimers();
    try {
      const waiters = new MeetingNodeAudioPullWaiters();
      const waiting = waiters.wait(250);

      expect(waiters.size).toBe(1);
      await vi.advanceTimersByTimeAsync(250);
      await waiting;

      expect(waiters.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
