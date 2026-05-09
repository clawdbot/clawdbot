import { describe, expect, it } from "vitest";
import { emitSessionLifecycleEvent, onSessionLifecycleEvent } from "./session-lifecycle-events.js";

function createListenerSpy(options: { throws?: boolean } = {}) {
  const calls: unknown[][] = [];
  return {
    calls,
    listener: (...args: unknown[]) => {
      calls.push(args);
      if (options.throws) {
        throw new Error("boom");
      }
    },
  };
}

describe("session lifecycle events", () => {
  it("delivers events to active listeners and stops after unsubscribe", () => {
    const { calls, listener } = createListenerSpy();
    const unsubscribe = onSessionLifecycleEvent(listener);

    emitSessionLifecycleEvent({
      sessionKey: "agent:main:main",
      reason: "created",
      label: "Main",
    });
    expect(calls).toEqual([
      [
        {
          sessionKey: "agent:main:main",
          reason: "created",
          label: "Main",
        },
      ],
    ]);

    unsubscribe();
    emitSessionLifecycleEvent({
      sessionKey: "agent:main:main",
      reason: "updated",
    });
    expect(calls).toHaveLength(1);
  });

  it("keeps notifying other listeners when one throws", () => {
    const noisy = createListenerSpy({ throws: true });
    const healthy = createListenerSpy();
    const unsubscribeNoisy = onSessionLifecycleEvent(noisy.listener);
    const unsubscribeHealthy = onSessionLifecycleEvent(healthy.listener);

    expect(
      emitSessionLifecycleEvent({
        sessionKey: "agent:main:main",
        reason: "resumed",
      }),
    ).toBeUndefined();

    expect(noisy.calls).toHaveLength(1);
    expect(healthy.calls).toHaveLength(1);

    unsubscribeNoisy();
    unsubscribeHealthy();
  });
});
