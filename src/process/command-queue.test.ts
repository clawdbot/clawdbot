import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandLane } from "./lanes.js";

const diagnosticMocks = vi.hoisted(() => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diag: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: diagnosticMocks.logLaneEnqueue,
  logLaneDequeue: diagnosticMocks.logLaneDequeue,
  diagnosticLogger: diagnosticMocks.diag,
}));

type CommandQueueModule = typeof import("./command-queue.js");

let clearCommandLane: CommandQueueModule["clearCommandLane"];
let CommandLaneClearedError: CommandQueueModule["CommandLaneClearedError"];
let CommandLaneTaskTimeoutError: CommandQueueModule["CommandLaneTaskTimeoutError"];
let enqueueCommand: CommandQueueModule["enqueueCommand"];
let enqueueCommandInLane: CommandQueueModule["enqueueCommandInLane"];
let GatewayDrainingError: CommandQueueModule["GatewayDrainingError"];
let getActiveTaskCount: CommandQueueModule["getActiveTaskCount"];
let getCommandLaneSnapshot: CommandQueueModule["getCommandLaneSnapshot"];
let getCommandLaneSnapshots: CommandQueueModule["getCommandLaneSnapshots"];
let getQueueSize: CommandQueueModule["getQueueSize"];
let markGatewayDraining: CommandQueueModule["markGatewayDraining"];
let resetAllLanes: CommandQueueModule["resetAllLanes"];
let resetCommandLane: CommandQueueModule["resetCommandLane"];
let resetCommandQueueStateForTest: CommandQueueModule["resetCommandQueueStateForTest"];
let setCommandLaneConcurrency: CommandQueueModule["setCommandLaneConcurrency"];
let waitForActiveTasks: CommandQueueModule["waitForActiveTasks"];

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function mockCallArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
  argIndex: number,
): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[argIndex];
}

function enqueueBlockedMainTask<T = void>(
  onRelease?: () => Promise<T> | T,
): {
  task: Promise<T>;
  release: () => void;
} {
  const deferred = createDeferred();
  const task = enqueueCommand(async () => {
    await deferred.promise;
    return (await onRelease?.()) as T;
  });
  return { task, release: deferred.resolve };
}

function expectLaneSnapshotFields(
  lane: string,
  fields: Partial<ReturnType<CommandQueueModule["getCommandLaneSnapshot"]>>,
): void {
  const snapshot = getCommandLaneSnapshot(lane);
  for (const [key, value] of Object.entries(fields)) {
    expect(snapshot[key as keyof typeof snapshot]).toBe(value);
  }
}

function diagnosticDebugMessages(): string[] {
  return diagnosticMocks.diag.debug.mock.calls
    .map(([message]) => message)
    .filter((message): message is string => typeof message === "string");
}

describe("command queue", () => {
  beforeAll(async () => {
    ({
      clearCommandLane,
      CommandLaneClearedError,
      CommandLaneTaskTimeoutError,
      enqueueCommand,
      enqueueCommandInLane,
      GatewayDrainingError,
      getActiveTaskCount,
      getCommandLaneSnapshot,
      getCommandLaneSnapshots,
      getQueueSize,
      markGatewayDraining,
      resetAllLanes,
      resetCommandLane,
      resetCommandQueueStateForTest,
      setCommandLaneConcurrency,
      waitForActiveTasks,
    } = await import("./command-queue.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    // Queue state is global across module instances, so reset main lane
    // concurrency explicitly to avoid cross-file leakage.
    setCommandLaneConcurrency(CommandLane.Main, 1);
    diagnosticMocks.logLaneEnqueue.mockClear();
    diagnosticMocks.logLaneDequeue.mockClear();
    diagnosticMocks.diag.debug.mockClear();
    diagnosticMocks.diag.warn.mockClear();
    diagnosticMocks.diag.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resetAllLanes is safe when no lanes have been created", () => {
    expect(getActiveTaskCount()).toBe(0);
    resetAllLanes();
    expect(getActiveTaskCount()).toBe(0);
  });

  it("runs tasks one at a time in order", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: number[] = [];

    const makeTask = (id: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(id);
      await Promise.resolve();
      active -= 1;
      return id;
    };

    const results = await Promise.all([
      enqueueCommand(makeTask(1)),
      enqueueCommand(makeTask(2)),
      enqueueCommand(makeTask(3)),
    ]);

    expect(results).toEqual([1, 2, 3]);
    expect(calls).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(getQueueSize()).toBe(0);
  });

  it("logs enqueue depth after push", async () => {
    const task = enqueueCommand(async () => {});

    expect(diagnosticMocks.logLaneEnqueue).toHaveBeenCalledTimes(1);
    expect(mockCallArg(diagnosticMocks.logLaneEnqueue, "logLaneEnqueue", 1)).toBe(1);

    await task;
  });

  it("invokes onWait callback when a task waits past the threshold", async () => {
    let waited: number | null = null;
    let queuedAhead: number | null = null;

    vi.useFakeTimers();
    try {
      const blocker = createDeferred();
      const first = enqueueCommand(async () => {
        await blocker.promise;
      });

      const second = enqueueCommand(async () => {}, {
        warnAfterMs: 5,
        onWait: (ms, ahead) => {
          waited = ms;
          queuedAhead = ahead;
        },
      });

      await vi.advanceTimersByTimeAsync(6);
      blocker.resolve();
      await Promise.all([first, second]);

      expect(typeof waited).toBe("number");
      expect(waited).toBeGreaterThanOrEqual(5);
      expect(queuedAhead).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("demotes live model switch lane failures to debug noise", async () => {
    const error = new Error("Live session model switch requested: anthropic/claude-opus-4-6");
    error.name = "LiveSessionModelSwitchError";

    await expect(
      enqueueCommandInLane("nested", async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(diagnosticMocks.diag.error).not.toHaveBeenCalled();
    expect(
      diagnosticDebugMessages().some((message) =>
        message.includes("lane task interrupted: lane=nested"),
      ),
    ).toBe(true);
  });

  it("getActiveTaskCount returns count of currently executing tasks", async () => {
    const { task, release } = enqueueBlockedMainTask();

    expect(getActiveTaskCount()).toBe(1);

    release();
    await task;
    expect(getActiveTaskCount()).toBe(0);
  });

  it("waitForActiveTasks resolves immediately when no tasks are active", async () => {
    const { drained } = await waitForActiveTasks(1000);
    expect(drained).toBe(true);
  });

  it("waitForActiveTasks waits for active tasks to finish", async () => {
    const { task, release } = enqueueBlockedMainTask();

    vi.useFakeTimers();
    try {
      const drainPromise = waitForActiveTasks(5000);

      await vi.advanceTimersByTimeAsync(50);
      release();
      await vi.advanceTimersByTimeAsync(50);

      const { drained } = await drainPromise;
      expect(drained).toBe(true);

      await task;
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitForActiveTasks returns drained=false when timeout is zero and tasks are active", async () => {
    const { task, release } = enqueueBlockedMainTask();

    const { drained } = await waitForActiveTasks(0);
    expect(drained).toBe(false);

    release();
    await task;
  });

  it("waitForActiveTasks returns drained=false on timeout", async () => {
    const { task, release } = enqueueBlockedMainTask();

    vi.useFakeTimers();
    try {
      const waitPromise = waitForActiveTasks(50);
      await vi.advanceTimersByTimeAsync(100);
      const { drained } = await waitPromise;
      expect(drained).toBe(false);

      release();
      await task;
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetAllLanes drains queued work immediately after reset", async () => {
    const lane = `reset-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    const blocker = createDeferred();

    // Start a task that blocks the lane
    const task1 = enqueueCommandInLane(lane, async () => {
      await blocker.promise;
    });

    expect(getActiveTaskCount()).toBeGreaterThanOrEqual(1);

    // Enqueue another task — it should be stuck behind the blocker
    let task2Ran = false;
    const task2 = enqueueCommandInLane(lane, async () => {
      task2Ran = true;
    });

    expect(getQueueSize(lane)).toBeGreaterThanOrEqual(2);
    expect(task2Ran).toBe(false);

    // Simulate SIGUSR1: reset all lanes. Queued work (task2) should be
    // drained immediately — no fresh enqueue needed.
    resetAllLanes();

    // Complete the stale in-flight task; generation mismatch makes its
    // completion path a no-op for queue bookkeeping.
    blocker.resolve();
    await task1;

    // task2 should have been pumped by resetAllLanes's drain pass.
    await task2;
    expect(task2Ran).toBe(true);
  });

  it("resetCommandLane releases one stuck lane and drains its queued work", async () => {
    const lane = `reset-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const otherLane = `reset-lane-other-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);
    setCommandLaneConcurrency(otherLane, 1);

    const blocker = createDeferred();
    const otherBlocker = createDeferred();
    const first = enqueueCommandInLane(lane, async () => {
      await blocker.promise;
      return "first";
    });
    const other = enqueueCommandInLane(otherLane, async () => {
      await otherBlocker.promise;
      return "other";
    });

    let secondRan = false;
    const second = enqueueCommandInLane(lane, async () => {
      secondRan = true;
      return "second";
    });

    expect(secondRan).toBe(false);
    expect(getActiveTaskCount()).toBe(2);
    expect(resetCommandLane(lane)).toBe(1);

    await expect(second).resolves.toBe("second");
    expect(secondRan).toBe(true);
    expect(getQueueSize(lane)).toBe(0);
    expect(getQueueSize(otherLane)).toBe(1);

    blocker.resolve();
    otherBlocker.resolve();
    await expect(first).resolves.toBe("first");
    await expect(other).resolves.toBe("other");
  });

  it("task timeout releases a stuck lane and drains queued work", async () => {
    const lane = `timeout-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    vi.useFakeTimers();
    try {
      const first = enqueueCommandInLane(lane, async () => new Promise<never>(() => {}), {
        taskTimeoutMs: 25,
      });
      const firstRejected = expect(first).rejects.toBeInstanceOf(CommandLaneTaskTimeoutError);
      let secondRan = false;
      const second = enqueueCommandInLane(lane, async () => {
        secondRan = true;
        return "second";
      });

      expect(secondRan).toBe(false);
      expectLaneSnapshotFields(lane, {
        activeCount: 1,
        queuedCount: 1,
      });

      await vi.advanceTimersByTimeAsync(25);

      await firstRejected;
      await expect(second).resolves.toBe("second");
      expect(secondRan).toBe(true);
      expectLaneSnapshotFields(lane, {
        activeCount: 0,
        queuedCount: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps work queued while a lane has zero concurrency and drains after resume", async () => {
    const lane = `suspended-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 0);

    let ran = false;
    const task = enqueueCommandInLane(lane, async () => {
      ran = true;
      return "resumed";
    });

    await Promise.resolve();
    expect(ran).toBe(false);
    expectLaneSnapshotFields(lane, {
      activeCount: 0,
      queuedCount: 1,
      maxConcurrent: 0,
    });

    setCommandLaneConcurrency(lane, 1);

    await expect(task).resolves.toBe("resumed");
    expect(ran).toBe(true);
    expectLaneSnapshotFields(lane, {
      activeCount: 0,
      queuedCount: 0,
      maxConcurrent: 1,
    });
  });

  it("getCommandLaneSnapshot reports active and queued work for one lane", async () => {
    const lane = `snapshot-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    const blocker = createDeferred();
    const first = enqueueCommandInLane(lane, async () => {
      await blocker.promise;
      return "first";
    });
    const second = enqueueCommandInLane(lane, async () => "second");

    expectLaneSnapshotFields(lane, {
      lane,
      activeCount: 1,
      queuedCount: 1,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    });

    blocker.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("getCommandLaneSnapshots reports all live lanes in stable order", async () => {
    const alphaLane = `snapshot-all-alpha-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const betaLane = `snapshot-all-beta-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(alphaLane, 1);
    setCommandLaneConcurrency(betaLane, 1);

    const alphaBlocker = createDeferred();
    const betaBlocker = createDeferred();
    const alpha = enqueueCommandInLane(alphaLane, async () => {
      await alphaBlocker.promise;
      return "alpha";
    });
    const beta = enqueueCommandInLane(betaLane, async () => {
      await betaBlocker.promise;
      return "beta";
    });

    const snapshots = getCommandLaneSnapshots().filter(
      (snapshot) => snapshot.lane === alphaLane || snapshot.lane === betaLane,
    );
    expect(snapshots.map((snapshot) => snapshot.lane)).toEqual([alphaLane, betaLane]);
    expect(snapshots[0]?.lane).toBe(alphaLane);
    expect(snapshots[0]?.activeCount).toBe(1);
    expect(snapshots[0]?.queuedCount).toBe(0);
    expect(snapshots[1]?.lane).toBe(betaLane);
    expect(snapshots[1]?.activeCount).toBe(1);
    expect(snapshots[1]?.queuedCount).toBe(0);

    alphaBlocker.resolve();
    betaBlocker.resolve();
    await expect(alpha).resolves.toBe("alpha");
    await expect(beta).resolves.toBe("beta");
  });

  it("waitForActiveTasks ignores tasks that start after the call", async () => {
    const lane = `drain-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 2);

    const blocker1 = createDeferred();
    const blocker2 = createDeferred();
    const firstStarted = createDeferred();

    const first = enqueueCommandInLane(lane, async () => {
      firstStarted.resolve();
      await blocker1.promise;
    });
    await firstStarted.promise;
    const drainPromise = waitForActiveTasks(2000);

    // Starts after waitForActiveTasks snapshot and should not block drain completion.
    const second = enqueueCommandInLane(lane, async () => {
      await blocker2.promise;
    });
    expect(getActiveTaskCount()).toBeGreaterThanOrEqual(2);

    blocker1.resolve();
    const { drained } = await drainPromise;
    expect(drained).toBe(true);

    blocker2.resolve();
    await Promise.all([first, second]);
  });

  it("clearCommandLane rejects pending promises", async () => {
    // First task blocks the lane.
    const { task: first, release } = enqueueBlockedMainTask(async () => "first");

    // Second task is queued behind the first.
    const second = enqueueCommand(async () => "second");

    const removed = clearCommandLane();
    expect(removed).toBe(1); // only the queued (not active) entry

    // The queued promise should reject.
    await expect(second).rejects.toBeInstanceOf(CommandLaneClearedError);

    // Let the active task finish normally.
    release();
    await expect(first).resolves.toBe("first");
  });

  it("keeps draining functional after synchronous onWait failure", async () => {
    const lane = `drain-sync-throw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    const deferred = createDeferred();
    const first = enqueueCommandInLane(lane, async () => {
      await deferred.promise;
      return "first";
    });
    const second = enqueueCommandInLane(lane, async () => "second", {
      warnAfterMs: 0,
      onWait: () => {
        throw new Error("onWait exploded");
      },
    });
    await Promise.resolve();
    expect(getQueueSize(lane)).toBeGreaterThanOrEqual(2);

    deferred.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("rejects new enqueues with GatewayDrainingError after markGatewayDraining", async () => {
    markGatewayDraining();
    await expect(enqueueCommand(async () => "blocked")).rejects.toBeInstanceOf(
      GatewayDrainingError,
    );
  });

  it("does not affect already-active tasks after markGatewayDraining", async () => {
    const { task, release } = enqueueBlockedMainTask(async () => "ok");
    markGatewayDraining();
    release();
    await expect(task).resolves.toBe("ok");
  });

  it("resetAllLanes clears gateway draining flag and re-allows enqueue", async () => {
    markGatewayDraining();
    resetAllLanes();
    await expect(enqueueCommand(async () => "ok")).resolves.toBe("ok");
  });

  it("migrates legacy queue state missing activeTaskWaiters without crashing", async () => {
    // Simulate a SIGUSR1 in-process restart where the globalThis singleton was
    // created by an older code version (e.g. v2026.4.2) that did not include
    // the `activeTaskWaiters` field.  The schema migration in getQueueState()
    // must patch the missing field so resetAllLanes() and
    // notifyActiveTaskWaiters() do not throw.
    const key = Symbol.for("openclaw.commandQueueState");
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const original = globalStore[key];

    try {
      // Plant a legacy-shaped state object (no activeTaskWaiters).
      globalStore[key] = {
        gatewayDraining: false,
        lanes: new Map(),
        nextTaskId: 1,
      };

      // resetAllLanes calls notifyActiveTaskWaiters → Array.from(state.activeTaskWaiters).
      // Without the migration this would throw:
      //   TypeError: undefined is not iterable
      resetAllLanes();

      // waitForActiveTasks also accesses activeTaskWaiters.
      await expect(waitForActiveTasks(0)).resolves.toEqual({ drained: true });
    } finally {
      // Restore original state so subsequent tests are not affected.
      if (original !== undefined) {
        globalStore[key] = original;
      } else {
        delete globalStore[key];
      }
      resetCommandQueueStateForTest();
    }
  });

  it("shares lane state across distinct module instances", async () => {
    const commandQueueA = await importFreshModule<typeof import("./command-queue.js")>(
      import.meta.url,
      "./command-queue.js?scope=shared-a",
    );
    const commandQueueB = await importFreshModule<typeof import("./command-queue.js")>(
      import.meta.url,
      "./command-queue.js?scope=shared-b",
    );
    const lane = `shared-state-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const blocker = createDeferred();

    commandQueueA.resetAllLanes();

    try {
      const task = commandQueueA.enqueueCommandInLane(lane, async () => {
        await blocker.promise;
        return "done";
      });

      expect(commandQueueB.getQueueSize(lane)).toBe(1);
      expect(commandQueueB.getActiveTaskCount()).toBe(1);

      blocker.resolve();
      await expect(task).resolves.toBe("done");
      expect(commandQueueB.getQueueSize(lane)).toBe(0);
    } finally {
      blocker.resolve();
      commandQueueA.resetAllLanes();
    }
  });
});
