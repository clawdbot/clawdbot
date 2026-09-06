// Command queue tests cover bounded command execution and queue ordering.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import {
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";
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
let enqueueCommandInLane: CommandQueueModule["enqueueCommandInLane"];
let GatewayDrainingError: CommandQueueModule["GatewayDrainingError"];
let getCommandLaneSnapshot: CommandQueueModule["getCommandLaneSnapshot"];
let getQueueSize: CommandQueueModule["getQueueSize"];
let getTotalQueueSize: CommandQueueModule["getTotalQueueSize"];
let markGatewayDraining: CommandQueueModule["markGatewayDraining"];
let resetAllLanes: CommandQueueModule["resetAllLanes"];
let resetCommandLane: CommandQueueModule["resetCommandLane"];
let setCommandLaneConcurrency: CommandQueueModule["setCommandLaneConcurrency"];

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
  const task = enqueueCommandInLane(CommandLane.Main, async () => {
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
      enqueueCommandInLane,
      GatewayDrainingError,
      getCommandLaneSnapshot,
      getQueueSize,
      getTotalQueueSize,
      markGatewayDraining,
      resetAllLanes,
      resetCommandLane,
      setCommandLaneConcurrency,
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
    expect(getTotalQueueSize()).toBe(0);
    resetAllLanes();
    expect(getTotalQueueSize()).toBe(0);
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
      enqueueCommandInLane(CommandLane.Main, makeTask(1)),
      enqueueCommandInLane(CommandLane.Main, makeTask(2)),
      enqueueCommandInLane(CommandLane.Main, makeTask(3)),
    ]);

    expect(results).toEqual([1, 2, 3]);
    expect(calls).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(getQueueSize()).toBe(0);
  });

  it("runs queued tasks in their enqueue-time async context", async () => {
    const context = new AsyncLocalStorage<string>();
    const blocker = createDeferred();
    const first = context.run("first", () =>
      enqueueCommandInLane(CommandLane.Main, async () => {
        await blocker.promise;
        return context.getStore();
      }),
    );
    const second = context.run("second", () =>
      enqueueCommandInLane(CommandLane.Main, async () => context.getStore()),
    );

    blocker.resolve();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("runs foreground work before already queued background work", async () => {
    const { task: blocker, release } = enqueueBlockedMainTask(async () => "blocker");
    const calls: string[] = [];

    const background = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("background");
        return "background";
      },
      { priority: "background" },
    );
    const normal = enqueueCommandInLane(CommandLane.Main, async () => {
      calls.push("normal");
      return "normal";
    });
    const foreground = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("foreground");
        return "foreground";
      },
      { priority: "foreground" },
    );

    release();
    await expect(blocker).resolves.toBe("blocker");
    await expect(foreground).resolves.toBe("foreground");
    await expect(normal).resolves.toBe("normal");
    await expect(background).resolves.toBe("background");
    expect(calls).toEqual(["foreground", "normal", "background"]);
  });

  it("preserves FIFO order within each priority", async () => {
    const { task: blocker, release } = enqueueBlockedMainTask(async () => "blocker");
    const calls: string[] = [];

    const first = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("first");
      },
      { priority: "foreground" },
    );
    const second = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("second");
      },
      { priority: "foreground" },
    );

    release();
    await blocker;
    await Promise.all([first, second]);
    expect(calls).toEqual(["first", "second"]);
  });

  it("preserves priority and FIFO order across partial drains and resumed growth", async () => {
    const lane = "priority-fifo-resume";
    const calls: string[] = [];
    const enqueue = (label: string, priority?: "foreground" | "background") =>
      enqueueCommandInLane(
        lane,
        async () => {
          calls.push(label);
        },
        { priority },
      );

    setCommandLaneConcurrency(lane, 0);
    const normal = Array.from({ length: 20 }, (_, index) => enqueue(`normal-${index}`));

    setCommandLaneConcurrency(lane, 5);
    setCommandLaneConcurrency(lane, 0);
    await Promise.all(normal.slice(0, 5));

    const resumedNormal = Array.from({ length: 20 }, (_, index) => enqueue(`normal-${index + 20}`));
    const background = Array.from({ length: 18 }, (_, index) =>
      enqueue(`background-${index}`, "background"),
    );
    const foreground = Array.from({ length: 18 }, (_, index) =>
      enqueue(`foreground-${index}`, "foreground"),
    );
    setCommandLaneConcurrency(lane, 1);
    await Promise.all([...normal, ...resumedNormal, ...background, ...foreground]);

    expect(calls).toEqual([
      ...Array.from({ length: 5 }, (_, index) => `normal-${index}`),
      ...Array.from({ length: 18 }, (_, index) => `foreground-${index}`),
      ...Array.from({ length: 35 }, (_, index) => `normal-${index + 5}`),
      ...Array.from({ length: 18 }, (_, index) => `background-${index}`),
    ]);
  });

  it("avoids quadratic array work as a paused queue doubles", () => {
    const script = String.raw`
      const { enqueueCommandInLane, setCommandLaneConcurrency } = await import(
        "./src/process/command-queue.ts"
      );
      const originalFindIndex = Array.prototype.findIndex;
      const originalShift = Array.prototype.shift;
      let enqueueComparisons = 0;
      let shiftedSlots = 0;

      Array.prototype.findIndex = function (predicate, thisArg) {
        return originalFindIndex.call(this, (value, index, array) => {
          enqueueComparisons += 1;
          return predicate.call(thisArg, value, index, array);
        });
      };
      Array.prototype.shift = function () {
        shiftedSlots += this.length;
        return originalShift.call(this);
      };

      const measureQueueWork = async (count) => {
        const lane = "linear-queue-" + count;
        setCommandLaneConcurrency(lane, 0);
        const comparisonStart = enqueueComparisons;
        const tasks = Array.from({ length: count }, (_, index) =>
          enqueueCommandInLane(lane, async () => index),
        );
        const enqueueWork = enqueueComparisons - comparisonStart;
        const shiftedSlotStart = shiftedSlots;
        setCommandLaneConcurrency(lane, count);
        const dequeueWork = shiftedSlots - shiftedSlotStart;
        await Promise.all(tasks);
        return { enqueueWork, dequeueWork };
      };

      const smaller = await measureQueueWork(256);
      const larger = await measureQueueWork(512);
      process.stdout.write(JSON.stringify({ smaller, larger }));
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
        },
        timeout: 60_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const measurements = JSON.parse(result.stdout) as {
      smaller: { enqueueWork: number; dequeueWork: number };
      larger: { enqueueWork: number; dequeueWork: number };
    };
    expect(measurements.larger.enqueueWork).toBeLessThanOrEqual(
      measurements.smaller.enqueueWork * 3 + 512,
    );
    expect(measurements.larger.dequeueWork).toBeLessThanOrEqual(
      measurements.smaller.dequeueWork * 3 + 512,
    );
  });

  it("does not report capacity waiting for an entry synchronously cleared during enqueue", async () => {
    const lane = "reentrant-clear";
    setCommandLaneConcurrency(lane, 0);
    diagnosticMocks.logLaneEnqueue.mockImplementationOnce(() => clearCommandLane(lane));
    const onQueued = vi.fn();
    await expect(
      enqueueCommandInLane(lane, async () => undefined, { onQueued }),
    ).rejects.toBeInstanceOf(CommandLaneClearedError);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("reports queueAhead after priority insertion", async () => {
    vi.useFakeTimers();
    try {
      const { task: blocker, release } = enqueueBlockedMainTask(async () => "blocker");
      const calls: string[] = [];
      let queuedAhead: number | null = null;

      const background = enqueueCommandInLane(
        CommandLane.Main,
        async () => {
          calls.push("background");
          return "background";
        },
        { priority: "background" },
      );
      const foreground = enqueueCommandInLane(
        CommandLane.Main,
        async () => {
          calls.push("foreground");
          return "foreground";
        },
        {
          priority: "foreground",
          warnAfterMs: 5,
          onWait: (_ms, ahead) => {
            queuedAhead = ahead;
          },
        },
      );

      await vi.advanceTimersByTimeAsync(6);
      release();
      await expect(blocker).resolves.toBe("blocker");
      await expect(foreground).resolves.toBe("foreground");
      await expect(background).resolves.toBe("background");

      expect(calls).toEqual(["foreground", "background"]);
      expect(queuedAhead).toBe(0);
      const waitWarning = diagnosticMocks.diag.warn.mock.calls.find(
        ([message]) =>
          typeof message === "string" && message.includes("lane wait exceeded: lane=main"),
      );
      expect(waitWarning?.[0]).toContain("queueAhead=0 activeAhead=1");
      expect(waitWarning?.[0]).toContain("queueBehind=1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs enqueue depth after push", async () => {
    const task = enqueueCommandInLane(CommandLane.Main, async () => {});

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
      const first = enqueueCommandInLane(CommandLane.Main, async () => {
        await blocker.promise;
      });

      const second = enqueueCommandInLane(CommandLane.Main, async () => {}, {
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
      const waitWarning = diagnosticMocks.diag.warn.mock.calls.find(
        ([message]) =>
          typeof message === "string" && message.includes("lane wait exceeded: lane=main"),
      );
      expect(waitWarning?.[0]).toContain("queueAhead=0 activeAhead=1");
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

  it("logs error types separately from the actionable lane failure message", async () => {
    const error = new Error("provider request failed");
    error.name = "FailoverError";

    await expect(
      enqueueCommandInLane(CommandLane.Main, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(diagnosticMocks.diag.error).toHaveBeenCalledWith(
      expect.not.stringContaining("FailoverError:"),
      expect.objectContaining({ errorName: "FailoverError" }),
    );
    expect(diagnosticMocks.diag.error).toHaveBeenCalledWith(
      expect.stringContaining('error="provider request failed"'),
      expect.any(Object),
    );
  });

  it.each([
    "session:probe-setup-inference:openai",
    "session:temp:setup-inference:probe-setup-inference-test-uuid",
  ])("keeps setup-inference probe lane failures quiet: %s", async (lane) => {
    const error = new Error("Authentication failed");

    await expect(
      enqueueCommandInLane(lane, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(diagnosticMocks.diag.error).not.toHaveBeenCalled();
    expect(
      diagnosticDebugMessages().some((message) =>
        message.includes(`lane task interrupted: lane=${lane}`),
      ),
    ).toBe(false);
  });

  it("reports process queue totals while tasks execute", async () => {
    const { task, release } = enqueueBlockedMainTask();

    expect(getTotalQueueSize()).toBe(1);

    release();
    await task;
    expect(getTotalQueueSize()).toBe(0);
  });

  it("resetAllLanes drains queued work immediately after reset", async () => {
    const lane = `reset-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    const blocker = createDeferred();

    // Start a task that blocks the lane
    const task1 = enqueueCommandInLane(lane, async () => {
      await blocker.promise;
    });

    expect(getTotalQueueSize()).toBeGreaterThanOrEqual(1);

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
    expect(
      getCommandLaneSnapshot(lane).activeCount + getCommandLaneSnapshot(otherLane).activeCount,
    ).toBe(2);
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
      const firstRejected = expect(first).rejects.toMatchObject({
        name: "CommandLaneTaskTimeoutError",
        message: expect.stringContaining("elapsed 25ms reached task budget 25ms"),
      });
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

  it("clamps oversized task timeouts before arming lane timers", async () => {
    const lane = `timeout-clamp-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const blocker = createDeferred();
      const task = enqueueCommandInLane(
        lane,
        async () => {
          await blocker.promise;
        },
        { taskTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1 },
      );

      await Promise.resolve();

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

      blocker.resolve();
      await task;
      setTimeoutSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("task timeout renews from progress timestamps", async () => {
    const lane = `timeout-progress-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    vi.useFakeTimers();
    try {
      let progressAtMs = Date.now();
      const blocker = createDeferred();
      const first = enqueueCommandInLane(
        lane,
        async () => {
          await blocker.promise;
          return "first";
        },
        {
          taskTimeoutMs: 25,
          taskTimeoutProgressAtMs: () => progressAtMs,
        },
      );
      let secondRan = false;
      const second = enqueueCommandInLane(lane, async () => {
        secondRan = true;
        return "second";
      });

      await vi.advanceTimersByTimeAsync(20);
      progressAtMs = Date.now();
      await vi.advanceTimersByTimeAsync(20);
      expect(secondRan).toBe(false);

      blocker.resolve();
      await expect(first).resolves.toBe("first");
      await expect(second).resolves.toBe("second");
      expect(secondRan).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("task timeout switches to a short abort grace period", async () => {
    const lane = `timeout-abort-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const first = enqueueCommandInLane(lane, async () => new Promise<never>(() => {}), {
        taskTimeoutMs: 48 * 60 * 60 * 1000,
        taskTimeoutAbortSignal: abortController.signal,
        taskTimeoutAbortGraceMs: 25,
      });
      const firstRejected = expect(first).rejects.toMatchObject({
        name: "CommandLaneTaskTimeoutError",
        message: expect.stringContaining(
          "abort grace 25ms elapsed (task budget 172800000ms, elapsed 25ms)",
        ),
      });
      let secondRan = false;
      const second = enqueueCommandInLane(lane, async () => {
        secondRan = true;
        return "second";
      });

      abortController.abort();
      await vi.advanceTimersByTimeAsync(24);
      expect(secondRan).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await firstRejected;
      await expect(second).resolves.toBe("second");
      expect(secondRan).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("task timeout release signal skips the abort grace period", async () => {
    const lane = `timeout-release-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    vi.useFakeTimers();
    try {
      const releaseController = new AbortController();
      const first = enqueueCommandInLane(lane, async () => new Promise<never>(() => {}), {
        taskTimeoutMs: 48 * 60 * 60 * 1000,
        taskTimeoutProgressAtMs: () => Date.now(),
        taskTimeoutAbortGraceMs: 25,
        taskTimeoutReleaseSignal: releaseController.signal,
      });
      const firstRejected = expect(first).rejects.toMatchObject({
        name: "CommandLaneTaskTimeoutError",
        message: expect.stringContaining(
          "lane release requested after 0ms (task budget 172800000ms)",
        ),
      });
      let secondRan = false;
      const second = enqueueCommandInLane(lane, async () => {
        secondRan = true;
        return "second";
      });

      releaseController.abort();
      await vi.advanceTimersByTimeAsync(0);

      await firstRejected;
      await expect(second).resolves.toBe("second");
      expect(secondRan).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("task timeout falls back when progress timestamp callback throws", async () => {
    const lane = `timeout-progress-throw-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    vi.useFakeTimers();
    try {
      const first = enqueueCommandInLane(lane, async () => new Promise<never>(() => {}), {
        taskTimeoutMs: 25,
        taskTimeoutProgressAtMs: () => {
          throw new Error("progress failed");
        },
      });
      const firstRejected = expect(first).rejects.toMatchObject({
        name: "CommandLaneTaskTimeoutError",
        message: expect.stringContaining("no progress for 25ms (task budget 25ms"),
      });

      await vi.advanceTimersByTimeAsync(25);
      await firstRejected;

      expect(
        diagnosticMocks.diag.warn.mock.calls.some(([message]) =>
          String(message).includes("lane task timeout progress callback failed"),
        ),
      ).toBe(true);
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

  it("clearCommandLane rejects pending promises at every priority", async () => {
    // First task blocks the lane.
    const { task: first, release } = enqueueBlockedMainTask(async () => "first");

    const background = enqueueCommandInLane(CommandLane.Main, async () => "background", {
      priority: "background",
    });
    const normal = enqueueCommandInLane(CommandLane.Main, async () => "normal");
    const foreground = enqueueCommandInLane(CommandLane.Main, async () => "foreground", {
      priority: "foreground",
    });
    const rejectionChecks = [background, normal, foreground].map((task) =>
      expect(task).rejects.toBeInstanceOf(CommandLaneClearedError),
    );

    const removed = clearCommandLane();
    expect(removed).toBe(3); // only the queued (not active) entries

    await Promise.all(rejectionChecks);

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
    await expect(
      enqueueCommandInLane(CommandLane.Main, async () => "blocked"),
    ).rejects.toBeInstanceOf(GatewayDrainingError);
  });

  it("does not affect already-active tasks after markGatewayDraining", async () => {
    const { task, release } = enqueueBlockedMainTask(async () => "ok");
    markGatewayDraining();
    release();
    await expect(task).resolves.toBe("ok");
  });

  it("reversibly fences new enqueues without disturbing an active task", async () => {
    const { task, release } = enqueueBlockedMainTask(async () => "active-finished");
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    await expect(
      enqueueCommandInLane(CommandLane.Main, async () => "blocked"),
    ).rejects.toBeInstanceOf(GatewayDrainingError);

    release();
    await expect(task).resolves.toBe("active-finished");
    expect(suspension?.release()).toBe(true);
    await expect(enqueueCommandInLane(CommandLane.Main, async () => "resumed")).resolves.toBe(
      "resumed",
    );
  });

  it("lets an admitted root enqueue while suspension preparation refuses new work", async () => {
    const continueRoot = createDeferred();
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    const result = root?.run(async () => {
      await continueRoot.promise;
      return await enqueueCommandInLane(CommandLane.Main, async () => "continued");
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});

    try {
      continueRoot.resolve();
      await expect(result).resolves.toBe("continued");
      await expect(
        enqueueCommandInLane(CommandLane.Main, async () => "blocked"),
      ).rejects.toBeInstanceOf(GatewayDrainingError);
    } finally {
      suspension?.rollback();
      root?.release();
    }
  });

  it("rejects subordinate enqueues from an admitted root after restart drain", async () => {
    const continueRoot = createDeferred();
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    const result = root?.run(async () => {
      await continueRoot.promise;
      return await enqueueCommandInLane(CommandLane.Main, async () => "blocked");
    });

    try {
      markGatewayDraining();
      continueRoot.resolve();
      await expect(result).rejects.toBeInstanceOf(GatewayDrainingError);
    } finally {
      root?.release();
    }
  });

  it("resetAllLanes clears gateway draining flag and re-allows enqueue", async () => {
    markGatewayDraining();
    resetAllLanes();
    await expect(enqueueCommandInLane(CommandLane.Main, async () => "ok")).resolves.toBe("ok");
  });

  it("re-admits preserved queued work after reset retires its captured root", async () => {
    const outerLane = `restart-outer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const innerLane = `restart-inner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(outerLane, 0);
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    let task: Promise<string> | undefined;
    await root?.run(async () => {
      task = enqueueCommandInLane(outerLane, async () =>
        enqueueCommandInLane(innerLane, async () => "continued"),
      );
    });

    markGatewayDraining();
    resetAllLanes();
    setCommandLaneConcurrency(outerLane, 1);

    await expect(task).resolves.toBe("continued");
    root?.release();
  });

  it("does not re-admit queued work after its root is released normally", async () => {
    const outerLane = `released-outer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const innerLane = `released-inner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(outerLane, 0);
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    let task: Promise<string> | undefined;
    await root?.run(async () => {
      task = enqueueCommandInLane(outerLane, async () =>
        enqueueCommandInLane(innerLane, async () => "unexpected"),
      );
    });

    root?.release();
    setCommandLaneConcurrency(outerLane, 1);

    await expect(task).rejects.toBeInstanceOf(GatewayDrainingError);
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
      expect(commandQueueB.getTotalQueueSize()).toBe(1);

      blocker.resolve();
      await expect(task).resolves.toBe("done");
      expect(commandQueueB.getQueueSize(lane)).toBe(0);
    } finally {
      blocker.resolve();
      commandQueueA.resetAllLanes();
    }
  });
});
