import { describe, expect, it, vi } from "vitest";
import { GatewayNodeLifecycleDispatchTracker } from "./node-lifecycle-dispatch.js";

describe("GatewayNodeLifecycleDispatchTracker", () => {
  it("drains every admitted node progress and terminal result", async () => {
    const tracker = new GatewayNodeLifecycleDispatchTracker();
    const events: string[] = [];
    let releaseProgress: (() => void) | undefined;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });

    const progress = tracker.dispatch("node.invoke.progress", async () => {
      events.push("progress-start");
      await progressGate;
      events.push("progress-end");
    });
    const result = tracker.dispatch("node.invoke.result", async () => {
      events.push("result");
    });
    const drained = tracker.drain(1_000);

    await vi.waitFor(() => expect(events).toEqual(["progress-start", "result"]));
    releaseProgress?.();

    await expect(Promise.all([progress, result])).resolves.toEqual([undefined, undefined]);
    await expect(drained).resolves.toBe(true);
    expect(events).toEqual(["progress-start", "result", "progress-end"]);
  });

  it("does not queue unrelated methods and bounds a stuck lifecycle drain", async () => {
    const tracker = new GatewayNodeLifecycleDispatchTracker();
    let releaseResult: (() => void) | undefined;
    const resultGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const result = tracker.dispatch("node.invoke.result", async () => {
      await resultGate;
    });

    await expect(tracker.dispatch("node.event", async () => undefined)).resolves.toBeUndefined();
    expect(tracker.hasActive()).toBe(true);
    await expect(tracker.drain(1)).resolves.toBe(false);

    releaseResult?.();
    await expect(result).resolves.toBeUndefined();
    expect(tracker.hasActive()).toBe(false);
    await expect(tracker.drain(1)).resolves.toBe(true);
  });
});
