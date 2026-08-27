import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingNodeAudioPullWaiters } from "./node-audio-pull-waiters.js";

describe("MeetingNodeAudioPullWaiters", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes a pull waiter when its timeout wins", async () => {
    vi.useFakeTimers();
    const waiters = new MeetingNodeAudioPullWaiters();
    const waiting = waiters.wait(250);

    expect(waiters.size).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    await waiting;

    expect(waiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pull timeout when audio wakes the waiter early", async () => {
    vi.useFakeTimers();
    const waiters = new MeetingNodeAudioPullWaiters();
    const waiting = waiters.wait(2_000);

    expect(waiters.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    waiters.wake();
    await waiting;

    expect(waiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases its real timeout resource when audio wakes the waiter early", async () => {
    const activeTimeouts = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
    const baselineTimeouts = activeTimeouts();
    const waiters = new MeetingNodeAudioPullWaiters();
    const waiting = waiters.wait(2_000);

    expect(waiters.size).toBe(1);
    expect(activeTimeouts()).toBe(baselineTimeouts + 1);
    waiters.wake();
    await waiting;

    expect(waiters.size).toBe(0);
    expect(activeTimeouts()).toBe(baselineTimeouts);
  });

  it("cancels every pull timeout when a wake releases concurrent waiters", async () => {
    vi.useFakeTimers();
    const waiters = new MeetingNodeAudioPullWaiters();
    const waiting = [waiters.wait(2_000), waiters.wait(2_000)];

    expect(waiters.size).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
    waiters.wake();
    await Promise.all(waiting);

    expect(waiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
