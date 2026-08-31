import { describe, expect, it, vi } from "vitest";
import { runMeetingBrowserAct } from "./browser-act-lock.js";

describe("meeting browser act lock", () => {
  it("serializes async evaluations for one browser target", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const run = async (name: string, gate?: Promise<void>) =>
      await runMeetingBrowserAct({
        deadline: Date.now() + 10_000,
        targetId: "target-1",
        operation: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          events.push(`start-${name}`);
          await gate;
          events.push(`end-${name}`);
          active -= 1;
        },
      });

    const first = run("first", firstGate);
    const second = run("second");
    await Promise.resolve();
    expect(events).toEqual(["start-first"]);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
    expect(events).toEqual(["start-first", "end-first", "start-second", "end-second"]);
  });

  it("releases the target after a failed evaluation", async () => {
    await expect(
      runMeetingBrowserAct({
        deadline: Date.now() + 10_000,
        targetId: "target-failure",
        operation: async () => {
          throw new Error("evaluation failed");
        },
      }),
    ).rejects.toThrow("evaluation failed");

    await expect(
      runMeetingBrowserAct({
        deadline: Date.now() + 10_000,
        targetId: "target-failure",
        operation: async () => "recovered",
      }),
    ).resolves.toBe("recovered");
  });

  it("does not start an evaluation after its queue deadline", async () => {
    vi.useFakeTimers();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = runMeetingBrowserAct({
      deadline: Date.now() + 10_000,
      targetId: "target-deadline",
      operation: async () => await firstGate,
    });
    let expiredStarted = false;
    const expired = runMeetingBrowserAct({
      deadline: Date.now() + 1_000,
      targetId: "target-deadline",
      operation: async () => {
        expiredStarted = true;
      },
    });

    const expiredResult = expect(expired).rejects.toThrow(
      "timed out waiting for browser tab control",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expiredResult;
    expect(expiredStarted).toBe(false);

    const third = runMeetingBrowserAct({
      deadline: Date.now() + 10_000,
      targetId: "target-deadline",
      operation: async () => "recovered",
    });
    releaseFirst?.();
    await first;
    await expect(third).resolves.toBe("recovered");
    expect(expiredStarted).toBe(false);
    vi.useRealTimers();
  });

  it("does not time out after the evaluation acquires the target", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const running = runMeetingBrowserAct({
      deadline: Date.now() + 1_000,
      targetId: "target-running",
      operation: async () => await gate,
    }).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    release?.();
    await expect(running).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
