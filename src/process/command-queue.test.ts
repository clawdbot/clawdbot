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
let enqueueCommand: CommandQueueModule["enqueueCommand"];
let enqueueCommandInLane: CommandQueueModule["enqueueCommandInLane"];
let GatewayDrainingError: CommandQueueModule["GatewayDrainingError"];
let getActiveTaskCount: CommandQueueModule["getActiveTaskCount"];
let getQueueSize: CommandQueueModule["getQueueSize"];
let markGatewayDraining: CommandQueueModule["markGatewayDraining"];
let resetAllLanes: CommandQueueModule["resetAllLanes"];
let resetCommandQueueStateForTest: CommandQueueModule["resetCommandQueueStateForTest"];
let setCommandLaneConcurrency: CommandQueueModule["setCommandLaneConcurrency"];
let waitForActiveTasks: CommandQueueModule["waitForActiveTasks"];

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

describe("command queue", () => {
  beforeAll(async () => {
    ({
      clearCommandLane,
      CommandLaneClearedError,
      enqueueCommand,
      enqueueCommandInLane,
      GatewayDrainingError,
      getActiveTaskCount,
      getQueueSize,
      markGatewayDraining,
      resetAllLanes,
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
    expect(() => resetAllLanes()).not.toThrow();
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
    expect(diagnosticMocks.logLaneEnqueue.mock.calls[0]?.[1]).toBe(1);

    await task;
  });

  it("invokes onWait callback when a task waits past the threshold", async () => {
    let waited: number | null = null;
    let queuedAhead: number | null = null;

    vi.useFakeTimers();
    try {
      let releaseFirst!: () => void;
      const blocker = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = enqueueCommand(async () => {
        await blocker;
      });

      const second = enqueueCommand(async () => {}, {
        warnAfterMs: 5,
        onWait: (ms, ahead) => {
          waited = ms;
          queuedAhead = ahead;
        },
      });

      await vi.advanceTimersByTimeAsync(6);
      releaseFirst();
      await Promise.all([first, second]);

      expect(waited).not.toBeNull();
      expect(waited as unknown as number).toBeGreaterThanOrEqual(5);
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
    expect(diagnosticMocks.diag.debug).toHaveBeenCalledWith(
      expect.stringContaining("lane task interrupted: lane=nested"),
    );
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

    let resolve1!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve1 = r;
    });

    // Start a task that blocks the lane
    const task1 = enqueueCommandInLane(lane, async () => {
      await blocker;
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
    resolve1();
    await task1;

    // task2 should have been pumped by resetAllLanes's drain pass.
    await task2;
    expect(task2Ran).toBe(true);
  });

  it("waitForActiveTasks ignores tasks that start after the call", async () => {
    const lane = `drain-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 2);

    let resolve1!: () => void;
    const blocker1 = new Promise<void>((r) => {
      resolve1 = r;
    });
    let resolve2!: () => void;
    const blocker2 = new Promise<void>((r) => {
      resolve2 = r;
    });
    const firstStarted = createDeferred();

    const first = enqueueCommandInLane(lane, async () => {
      firstStarted.resolve();
      await blocker1;
    });
    await firstStarted.promise;
    const drainPromise = waitForActiveTasks(2000);

    // Starts after waitForActiveTasks snapshot and should not block drain completion.
    const second = enqueueCommandInLane(lane, async () => {
      await blocker2;
    });
    expect(getActiveTaskCount()).toBeGreaterThanOrEqual(2);

    resolve1();
    const { drained } = await drainPromise;
    expect(drained).toBe(true);

    resolve2();
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
      expect(() => resetAllLanes()).not.toThrow();

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

    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    commandQueueA.resetAllLanes();

    try {
      const task = commandQueueA.enqueueCommandInLane(lane, async () => {
        await blocker;
        return "done";
      });

      expect(commandQueueB.getQueueSize(lane)).toBe(1);
      expect(commandQueueB.getActiveTaskCount()).toBe(1);

      release();
      await expect(task).resolves.toBe("done");
      expect(commandQueueB.getQueueSize(lane)).toBe(0);
    } finally {
      release();
      commandQueueA.resetAllLanes();
    }
  });
});
