// Regression coverage for lifecycle-owned cleanup of ephemeral command lanes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  getTotalQueueSize,
  resetCommandLane,
  setCommandLaneConcurrency,
} from "./command-queue.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import { CommandLane } from "./lanes.js";

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function getCommandLaneRegistryForTest(): Map<string, unknown> {
  const state = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.commandQueueState")
  ];
  const lanes = (state as { lanes?: unknown } | undefined)?.lanes;
  if (!(lanes instanceof Map)) {
    throw new Error("Expected the shared command lane registry to be initialized");
  }
  return lanes as Map<string, unknown>;
}

describe("scoped command lane lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Main, 1);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
  });

  it.each(["session:", "nested:", "context-engine-turn-maintenance:"])(
    "retires ten independently completed %s lanes from the shared registry",
    async (prefix) => {
      const lanes = getCommandLaneRegistryForTest();
      const baselineSize = lanes.size;
      const allRunsStarted = createDeferred();
      let activeRuns = 0;
      let peakActiveRuns = 0;
      const laneNames = Array.from(
        { length: 10 },
        (_, index) => `${prefix}agent:main:autoqa-${index}`,
      );

      const results = await Promise.all(
        laneNames.map((lane, index) =>
          enqueueCommandInLane(lane, async () => {
            activeRuns += 1;
            peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
            if (activeRuns === laneNames.length) {
              allRunsStarted.resolve();
            }
            await allRunsStarted.promise;
            activeRuns -= 1;
            return index;
          }),
        ),
      );

      expect(results).toEqual(Array.from({ length: 10 }, (_, index) => index));
      expect(peakActiveRuns).toBe(10);
      expect(activeRuns).toBe(0);
      expect(getTotalQueueSize()).toBe(0);
      expect(lanes.size).toBe(baselineSize);
      for (const lane of laneNames) {
        expect(lanes.has(lane)).toBe(false);
      }
    },
  );

  it("keeps a session lane until its queued successor finishes", async () => {
    const lanes = getCommandLaneRegistryForTest();
    const lane = "session:agent:main:autoqa-queued";
    const firstGate = createDeferred();
    const secondGate = createDeferred();

    const first = enqueueCommandInLane(lane, async () => {
      await firstGate.promise;
      return "first";
    });
    const second = enqueueCommandInLane(lane, async () => {
      await secondGate.promise;
      return "second";
    });

    expect(lanes.has(lane)).toBe(true);
    firstGate.resolve();
    await expect(first).resolves.toBe("first");
    expect(lanes.has(lane)).toBe(true);
    expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 0 });

    secondGate.resolve();
    await expect(second).resolves.toBe("second");
    expect(lanes.has(lane)).toBe(false);
  });

  it("preserves explicitly configured and paused dynamic lanes", async () => {
    const lanes = getCommandLaneRegistryForTest();
    const configuredLane = "session:agent:main:autoqa-configured";
    const pausedLane = "nested:agent:main:autoqa-paused";

    setCommandLaneConcurrency(configuredLane, 2);
    await Promise.all([
      enqueueCommandInLane(configuredLane, async () => "first"),
      enqueueCommandInLane(configuredLane, async () => "second"),
    ]);

    expect(lanes.has(configuredLane)).toBe(true);
    expect(getCommandLaneSnapshot(configuredLane)).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
      maxConcurrent: 2,
    });

    setCommandLaneConcurrency(pausedLane, 0);
    let pausedRunStarted = false;
    const pausedRun = enqueueCommandInLane(pausedLane, async () => {
      pausedRunStarted = true;
      return "resumed";
    });

    expect(pausedRunStarted).toBe(false);
    expect(lanes.has(pausedLane)).toBe(true);
    expect(getCommandLaneSnapshot(pausedLane)).toMatchObject({
      activeCount: 0,
      queuedCount: 1,
      maxConcurrent: 0,
    });

    setCommandLaneConcurrency(pausedLane, 1);
    await expect(pausedRun).resolves.toBe("resumed");
    expect(lanes.has(pausedLane)).toBe(false);
    expect(lanes.has(configuredLane)).toBe(true);
  });

  it("does not let stale session completion retire a replacement-generation run", async () => {
    const lanes = getCommandLaneRegistryForTest();
    const lane = "session:agent:main:autoqa-replacement";
    const staleGate = createDeferred();
    const replacementGate = createDeferred();
    const staleRun = enqueueCommandInLane(lane, async () => {
      await staleGate.promise;
      return "stale";
    });

    expect(resetCommandLane(lane)).toBe(1);
    const replacementRun = enqueueCommandInLane(lane, async () => {
      await replacementGate.promise;
      return "replacement";
    });
    const replacementState = lanes.get(lane);

    staleGate.resolve();
    await expect(staleRun).resolves.toBe("stale");
    expect(lanes.get(lane)).toBe(replacementState);
    expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 0 });

    replacementGate.resolve();
    await expect(replacementRun).resolves.toBe("replacement");
    expect(lanes.has(lane)).toBe(false);
  });

  it("preserves gateway-managed fixed lanes while scoped lanes finish", async () => {
    const lanes = getCommandLaneRegistryForTest();
    const fixedLanes = [
      CommandLane.Main,
      CommandLane.SystemAgent,
      CommandLane.Cron,
      CommandLane.CronNested,
      CommandLane.SkillWorkshopReview,
      CommandLane.Subagent,
      CommandLane.Nested,
    ];

    for (const lane of fixedLanes) {
      setCommandLaneConcurrency(lane, 1);
    }

    const scopedLanes = [
      "session:agent:main:autoqa-fixed",
      "nested:agent:main:autoqa-fixed",
      "context-engine-turn-maintenance:agent:main:autoqa-fixed",
    ];
    await Promise.all(scopedLanes.map((lane) => enqueueCommandInLane(lane, async () => lane)));

    for (const lane of fixedLanes) {
      expect(lanes.has(lane)).toBe(true);
      expect(getCommandLaneSnapshot(lane)).toMatchObject({
        activeCount: 0,
        queuedCount: 0,
        maxConcurrent: 1,
      });
    }
    for (const lane of scopedLanes) {
      expect(lanes.has(lane)).toBe(false);
    }
  });

  it("recreates a maintenance lane for deferred same-session follow-up work", async () => {
    const lanes = getCommandLaneRegistryForTest();
    const lane = "context-engine-turn-maintenance:agent:main:autoqa-rerun";
    const replacementGate = createDeferred();
    const firstRun = enqueueCommandInLane(lane, async () => "first");
    const originalState = lanes.get(lane);
    const replacementRun = firstRun.then(() =>
      enqueueCommandInLane(lane, async () => {
        await replacementGate.promise;
        return "replacement";
      }),
    );

    await expect(firstRun).resolves.toBe("first");
    expect(lanes.has(lane)).toBe(true);
    expect(lanes.get(lane)).not.toBe(originalState);
    expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 0 });

    replacementGate.resolve();
    await expect(replacementRun).resolves.toBe("replacement");
    expect(lanes.has(lane)).toBe(false);
  });

  it("does not retire a newer lane state when stale work finishes", async () => {
    const lanes = getCommandLaneRegistryForTest();
    const lane = "session:agent:main:autoqa-recreated-state";
    const staleGate = createDeferred();
    const staleRun = enqueueCommandInLane(lane, async () => {
      await staleGate.promise;
      return "stale";
    });
    const replacementState = {
      lane,
      queue: [],
      activeTaskIds: new Set<number>(),
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    };

    lanes.set(lane, replacementState);
    staleGate.resolve();
    await expect(staleRun).resolves.toBe("stale");

    expect(lanes.get(lane)).toBe(replacementState);
    lanes.delete(lane);
  });

  it("retires a scoped lane after its active task rejects", async () => {
    const lanes = getCommandLaneRegistryForTest();
    const lane = "nested:agent:main:autoqa-rejected";

    await expect(
      enqueueCommandInLane(lane, async () => {
        throw new Error("scoped task failed");
      }),
    ).rejects.toThrow("scoped task failed");

    expect(lanes.has(lane)).toBe(false);
  });

  it("retires a scoped lane after its active task times out", async () => {
    const lanes = getCommandLaneRegistryForTest();
    const lane = "session:agent:main:autoqa-timed-out";

    vi.useFakeTimers();
    try {
      const timedOut = enqueueCommandInLane(lane, async () => new Promise<never>(() => {}), {
        taskTimeoutMs: 5,
      });
      const rejection = expect(timedOut).rejects.toMatchObject({
        name: "CommandLaneTaskTimeoutError",
      });

      await vi.advanceTimersByTimeAsync(5);
      await rejection;

      expect(lanes.has(lane)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
