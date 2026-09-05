import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureNodeWakeLifecycle,
  clearNodeWakeState,
  invalidateNodeWakeState,
  isNodeWakeLifecycleCurrent,
  releaseNodeWakeLifecycle,
  runNodeWakeAttempt,
  runNodeWakeNudgeAttempt,
  type NodeWakeAttempt,
} from "./node-wake-state.js";
import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
} from "./node-wake-state.test-support.js";

const sentWake: NodeWakeAttempt = {
  available: true,
  throttled: false,
  path: "sent",
  durationMs: 1,
};

beforeEach(() => {
  resetNodeWakeStateForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("node wake lifecycle ownership", () => {
  it("isolates generations and invalidates every generation for a removed node", () => {
    const generationOne = captureNodeWakeLifecycle("node-1", "generation-1");
    const generationTwo = captureNodeWakeLifecycle("node-1", "generation-2");

    expect(isNodeWakeLifecycleCurrent("node-1", generationOne, "generation-1")).toBe(true);
    expect(isNodeWakeLifecycleCurrent("node-1", generationOne, "generation-2")).toBe(false);
    expect(isNodeWakeLifecycleCurrent("node-1", generationTwo, "generation-2")).toBe(true);

    invalidateNodeWakeState("node-1");

    expect(generationOne.aborted).toBe(true);
    expect(generationTwo.aborted).toBe(true);
    expect(getNodeWakeStateSnapshot("node-1", "generation-1")).toBeUndefined();
    expect(getNodeWakeStateSnapshot("node-1", "generation-2")).toBeUndefined();
  });

  it("releases an idle lifecycle without retaining owner state", () => {
    const lifecycle = captureNodeWakeLifecycle("node-idle");

    releaseNodeWakeLifecycle("node-idle", lifecycle);

    expect(lifecycle.aborted).toBe(true);
    expect(getNodeWakeStateSnapshot("node-idle")).toBeUndefined();
  });

  it("clears throttle state without aborting an active lifecycle", async () => {
    const lifecycle = captureNodeWakeLifecycle("node-active");
    await runNodeWakeAttempt({
      nodeId: "node-active",
      force: true,
      throttleMs: 1_000,
      attempt: async (markAttempted) => {
        markAttempted();
        return sentWake;
      },
    });

    clearNodeWakeState("node-active");

    expect(lifecycle.aborted).toBe(false);
    expect(getNodeWakeStateSnapshot("node-active")?.lastWakeAtMs).toBeUndefined();
    releaseNodeWakeLifecycle("node-active", lifecycle);
  });
});

describe("node wake coordination", () => {
  it.each([-3_600_000, 3_600_000])(
    "keeps wake and nudge throttle intervals across a %i ms wall-clock change",
    async (clockChange) => {
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(10_000_000);
      const wake = () =>
        runNodeWakeAttempt({
          nodeId: "clock-node",
          force: false,
          throttleMs: 1_000,
          attempt: async (markAttempted) => {
            markAttempted();
            return sentWake;
          },
        });
      const nudge = () =>
        runNodeWakeNudgeAttempt({
          nodeId: "clock-node",
          throttleMs: 1_000,
          throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
          attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 0 }),
        });

      expect((await wake()).path).toBe("sent");
      expect((await nudge()).reason).toBe("sent");
      wallClock.mockReturnValue(10_000_000 + clockChange);
      elapsed = 999;
      expect((await wake()).path).toBe("throttled");
      expect((await nudge()).reason).toBe("throttled");
      elapsed = 1_000;
      expect((await wake()).path).toBe("sent");
      expect((await nudge()).reason).toBe("sent");
    },
  );

  it("deduplicates concurrent wake attempts for one generation", async () => {
    let finish: ((attempt: NodeWakeAttempt) => void) | undefined;
    const attempt = vi.fn(
      () =>
        new Promise<NodeWakeAttempt>((resolve) => {
          finish = resolve;
        }),
    );
    const params = {
      nodeId: "node-1",
      pairingGeneration: "generation-1",
      force: false,
      throttleMs: 1_000,
      attempt,
    };

    const first = runNodeWakeAttempt(params);
    const second = runNodeWakeAttempt(params);
    expect(attempt).toHaveBeenCalledOnce();
    finish?.(sentWake);

    await expect(first).resolves.toEqual(sentWake);
    await expect(second).resolves.toEqual(sentWake);
  });

  it("throttles only after transport admission marks a real wake attempt", async () => {
    await runNodeWakeAttempt({
      nodeId: "node-1",
      force: false,
      throttleMs: 60_000,
      attempt: async (markAttempted) => {
        markAttempted();
        return sentWake;
      },
    });

    const second = await runNodeWakeAttempt({
      nodeId: "node-1",
      force: false,
      throttleMs: 60_000,
      attempt: async () => sentWake,
    });

    expect(second).toEqual({
      available: true,
      throttled: true,
      path: "throttled",
      durationMs: 0,
    });
  });

  it("tracks reconnect-nudge throttle independently from wake throttle", async () => {
    const sent = await runNodeWakeNudgeAttempt({
      nodeId: "node-1",
      throttleMs: 60_000,
      throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
      attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 1 }),
    });
    const throttled = await runNodeWakeNudgeAttempt({
      nodeId: "node-1",
      throttleMs: 60_000,
      throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
      attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 1 }),
    });

    expect(sent.reason).toBe("sent");
    expect(throttled.reason).toBe("throttled");
    expect(getNodeWakeStateSnapshot("node-1")?.lastWakeAtMs).toBeUndefined();
    expect(getNodeWakeStateSnapshot("node-1")?.lastNudgeAtMs).toBeGreaterThan(0);
  });
});
