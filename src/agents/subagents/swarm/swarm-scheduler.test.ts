import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateSwarmRun,
  bindSwarmRunReservation,
  enqueueSwarmRun,
  isSwarmRunActive,
  isSwarmRunWaitingForCapacity,
  holdQueuedSwarmRun,
  releaseSwarmRun,
  removeQueuedSwarmRun,
  reserveSwarmRun,
} from "./swarm-scheduler.js";
import { testing } from "./swarm-scheduler.test-support.js";

// queueMicrotask-driven starts need real microtask turns; fake timers'
// runAllTicks only drains nextTick, so flush the microtask queue explicitly.
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

describe("swarm scheduler", () => {
  beforeEach(() => {
    testing.reset();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("starts collector runs FIFO as group slots free", async () => {
    const started: string[] = [];
    const start = (runId: string) => async () => {
      started.push(runId);
    };
    const onStartFailure = vi.fn(() => true);

    enqueueSwarmRun({
      groupId: "group",
      runId: "one",
      maxConcurrent: 1,
      activeRunIds: [],
      start: start("one"),
      onStartFailure,
    });
    enqueueSwarmRun({
      groupId: "group",
      runId: "two",
      maxConcurrent: 1,
      activeRunIds: [],
      start: start("two"),
      onStartFailure,
    });
    enqueueSwarmRun({
      groupId: "group",
      runId: "three",
      maxConcurrent: 1,
      activeRunIds: [],
      start: start("three"),
      onStartFailure,
    });
    const owner = {};
    const waits: boolean[] = [];
    bindSwarmRunReservation("two", owner, () => {
      waits.push(isSwarmRunWaitingForCapacity("two", owner));
    });

    await vi.waitFor(() => expect(started).toEqual(["one"]));
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(true);
    expect(isSwarmRunWaitingForCapacity("two", {})).toBe(false);
    expect(releaseSwarmRun("one")).toBe(true);
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(false);
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
    expect(waits).toEqual([true, false]);
    expect(releaseSwarmRun("two")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
    expect(onStartFailure).not.toHaveBeenCalled();
  });

  it("preserves admission order when later preparation finishes first", async () => {
    const started: string[] = [];
    const reserve = (runId: string) =>
      reserveSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent: 1,
        activeRunIds: [],
      });
    const activate = (runId: string) =>
      activateSwarmRun({
        groupId: "group",
        runId,
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });

    expect(reserve("one")).toBe(true);
    expect(reserve("two")).toBe(true);
    const owner = {};
    bindSwarmRunReservation("two", owner);
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(false);
    activate("two");
    await Promise.resolve();
    expect(started).toEqual([]);
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(false);

    activate("one");
    await vi.waitFor(() => expect(started).toEqual(["one"]));
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(true);
    expect(releaseSwarmRun("one")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
  });

  it("removes a cancelled queued run before the next slot opens", async () => {
    const started: string[] = [];
    const enqueue = (runId: string) =>
      enqueueSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent: 1,
        activeRunIds: [],
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });

    enqueue("one");
    enqueue("two");
    enqueue("three");
    const owner = {};
    const waits: boolean[] = [];
    bindSwarmRunReservation("two", owner, () => {
      waits.push(isSwarmRunWaitingForCapacity("two", owner));
    });
    await vi.waitFor(() => expect(started).toEqual(["one"]));
    const hold = holdQueuedSwarmRun("two");
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(false);
    hold?.release();
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(true);
    expect(removeQueuedSwarmRun("two")).toBe(true);
    expect(waits).toEqual([true, false, true, false]);
    releaseSwarmRun("one");
    await vi.waitFor(() => expect(started).toEqual(["one", "three"]));
  });

  it("dispatches independent groups while restored capacity preserves FIFO", async () => {
    const started: string[] = [];
    for (const [runId, groupId, activeRunIds] of [
      ["queued", "restored-group", ["restored-active"]],
      ["other", "other-group", []],
    ] as const) {
      enqueueSwarmRun({
        groupId,
        runId,
        activeRunIds,
        maxConcurrent: 1,
        start: async () => {
          started.push(runId);
        },
        onStartFailure: () => true,
      });
    }
    await vi.waitFor(() => expect(started).toEqual(["other"]));
    expect(releaseSwarmRun("restored-active")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["other", "queued"]));
  });

  it("keeps a live reservation queued when a later snapshot reports it active", async () => {
    expect(
      reserveSwarmRun({
        groupId: "group",
        runId: "queued",
        maxConcurrent: 1,
        activeRunIds: [],
      }),
    ).toBe(true);
    expect(
      reserveSwarmRun({
        groupId: "group",
        runId: "next",
        maxConcurrent: 1,
        activeRunIds: ["queued"],
      }),
    ).toBe(true);

    const started: string[] = [];
    activateSwarmRun({
      groupId: "group",
      runId: "queued",
      start: async () => {
        started.push("queued");
      },
      onStartFailure: vi.fn(() => true),
    });
    await vi.waitFor(() => expect(started).toEqual(["queued"]));
    activateSwarmRun({
      groupId: "group",
      runId: "next",
      start: async () => {
        started.push("next");
      },
      onStartFailure: () => true,
    });
    await flushMicrotasks();
    expect(started).toEqual(["queued"]);
    releaseSwarmRun("queued");
    await vi.waitFor(() => expect(started).toEqual(["queued", "next"]));
  });

  it("retries the same queued run when failure persistence throws", async () => {
    const started: string[] = [];
    let brokenAttempts = 0;
    enqueueSwarmRun({
      groupId: "group",
      runId: "broken",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        brokenAttempts += 1;
        if (brokenAttempts === 1) {
          throw new Error("launch failed");
        }
        started.push("broken");
      },
      onStartFailure: () => {
        throw new Error("persistence failed");
      },
    });
    enqueueSwarmRun({
      groupId: "group",
      runId: "next",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        started.push("next");
      },
      onStartFailure: vi.fn(() => true),
    });

    await vi.waitFor(() => expect(started).toEqual(["broken"]));
    expect(brokenAttempts).toBe(2);
    expect(releaseSwarmRun("broken")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["broken", "next"]));
  });

  it("does not let a stale retry release the successful replacement attempt", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    let brokenAttempts = 0;
    enqueueSwarmRun({
      groupId: "group",
      runId: "broken",
      maxConcurrent: 2,
      activeRunIds: [],
      start: async () => {
        brokenAttempts += 1;
        if (brokenAttempts === 1) {
          throw new Error("launch failed");
        }
        started.push("broken");
      },
      onStartFailure: () => {
        throw new Error("persistence failed");
      },
    });
    for (const runId of ["holding", "next"]) {
      enqueueSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent: 2,
        activeRunIds: [],
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });
    }
    await flushMicrotasks();
    await flushMicrotasks();
    expect(brokenAttempts).toBe(1);
    expect(started).toEqual(["holding"]);

    expect(releaseSwarmRun("holding")).toBe(true);
    await flushMicrotasks();
    expect(brokenAttempts).toBe(1);
    expect(started).toEqual(["holding"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(brokenAttempts).toBe(2);
    expect(started).toEqual(["holding", "broken", "next"]);
    expect(releaseSwarmRun("broken")).toBe(true);
  });

  it("holds the group slot until asynchronous failure cleanup finishes", async () => {
    const started: string[] = [];
    let finishCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    enqueueSwarmRun({
      groupId: "group",
      runId: "failed",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        started.push("failed");
        throw new Error("launch failed");
      },
      onStartFailure: async () => {
        await cleanup;
        return true;
      },
    });
    enqueueSwarmRun({
      groupId: "group",
      runId: "next",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        started.push("next");
      },
      onStartFailure: vi.fn(() => true),
    });

    await vi.waitFor(() => expect(started).toEqual(["failed"]));
    finishCleanup?.();
    await vi.waitFor(() => expect(started).toEqual(["failed", "next"]));
  });

  it("does not refill until active runs fall below a reduced limit", async () => {
    const started: string[] = [];
    const enqueue = (runId: string, maxConcurrent: number) =>
      enqueueSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent,
        activeRunIds: [],
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });

    enqueue("one", 2);
    enqueue("two", 2);
    enqueue("three", 2);
    const owner = {};
    const waits: boolean[] = [];
    bindSwarmRunReservation("three", owner, () => {
      waits.push(isSwarmRunWaitingForCapacity("three", owner));
    });
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
    enqueue("four", 1);

    releaseSwarmRun("one");
    await Promise.resolve();
    expect(started).toEqual(["one", "two"]);
    expect(waits).toEqual([true]);
    releaseSwarmRun("two");
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
    expect(waits).toEqual([true, false]);
  });

  it("refreshes the lane limit before rejecting a duplicate reservation", async () => {
    const started: string[] = [];
    const enqueue = (runId: string) =>
      enqueueSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent: 2,
        activeRunIds: [],
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });

    enqueue("one");
    enqueue("two");
    enqueue("three");
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));

    expect(
      reserveSwarmRun({
        groupId: "group",
        runId: "one",
        maxConcurrent: 1,
        activeRunIds: ["one", "two"],
      }),
    ).toBe(false);
    expect(releaseSwarmRun("one")).toBe(true);
    await Promise.resolve();
    expect(started).toEqual(["one", "two"]);
    expect(releaseSwarmRun("two")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
  });

  it("does not retry a failed start after its scheduler slot was released", async () => {
    vi.useFakeTimers();
    let finishCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let failedAttempts = 0;
    const started: string[] = [];
    enqueueSwarmRun({
      groupId: "group",
      runId: "failed",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        failedAttempts += 1;
        throw new Error("launch failed");
      },
      onStartFailure: async () => {
        await cleanup;
        throw new Error("persistence failed");
      },
    });
    await flushMicrotasks();
    expect(failedAttempts).toBe(1);
    expect(releaseSwarmRun("failed")).toBe(true);

    enqueueSwarmRun({
      groupId: "group",
      runId: "replacement",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        started.push("replacement");
      },
      onStartFailure: vi.fn(() => true),
    });
    await flushMicrotasks();
    expect(started).toEqual(["replacement"]);

    finishCleanup?.();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    expect(failedAttempts).toBe(1);
  });

  it("does not let stale failed-start cleanup mutate a reused run id", async () => {
    vi.useFakeTimers();
    let finishCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let reusedAttempts = 0;
    enqueueSwarmRun({
      groupId: "group",
      runId: "reused",
      maxConcurrent: 2,
      activeRunIds: [],
      start: async () => {
        reusedAttempts += 1;
        throw new Error("launch failed");
      },
      onStartFailure: async () => {
        await cleanup;
        throw new Error("persistence failed");
      },
    });
    enqueueSwarmRun({
      groupId: "group",
      runId: "holder",
      maxConcurrent: 2,
      activeRunIds: [],
      start: async () => {},
      onStartFailure: vi.fn(() => true),
    });
    await flushMicrotasks();
    expect(reusedAttempts).toBe(1);
    expect(releaseSwarmRun("reused")).toBe(true);

    enqueueSwarmRun({
      groupId: "group",
      runId: "reused",
      maxConcurrent: 2,
      activeRunIds: [],
      start: async () => {
        reusedAttempts += 1;
      },
      onStartFailure: vi.fn(() => true),
    });
    await flushMicrotasks();
    expect(reusedAttempts).toBe(2);

    finishCleanup?.();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    expect(reusedAttempts).toBe(2);
    expect(releaseSwarmRun("reused")).toBe(true);
  });

  it("fills increased capacity from the existing FIFO queue", async () => {
    const started: string[] = [];
    const enqueue = (runId: string, maxConcurrent: number) =>
      enqueueSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent,
        activeRunIds: [],
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });

    enqueue("one", 1);
    enqueue("two", 1);
    enqueue("three", 3);

    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
  });
  it.each(["before", "during"])(
    "holds FIFO across activation %s the hold and overlapping cancellations",
    async (activation) => {
      const started: string[] = [];
      reserveSwarmRun({ groupId: "group", runId: "held", maxConcurrent: 1, activeRunIds: [] });
      const activate = () =>
        activateSwarmRun({
          groupId: "group",
          runId: "held",
          start: async () => {
            started.push("held");
          },
          onStartFailure: () => true,
        });
      if (activation === "before") {
        activate();
      }
      const first = holdQueuedSwarmRun("held");
      const second = holdQueuedSwarmRun("held");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (activation === "during") {
        activate();
      }
      for (const [runId, groupId] of [
        ["next", "group"],
        ["foreign", "other-group"],
      ] as const) {
        enqueueSwarmRun({
          groupId,
          runId,
          maxConcurrent: 1,
          activeRunIds: [],
          start: async () => {
            started.push(runId);
          },
          onStartFailure: () => true,
        });
      }
      try {
        await flushMicrotasks();
        expect(started).toEqual(["foreign"]);
        expect(isSwarmRunActive("held")).toBe(false);
        first?.release();
        first?.release();
        await flushMicrotasks();
        expect(started).toEqual(["foreign"]);
        second?.release();
        await flushMicrotasks();
        expect(started).toEqual(["foreign", "held"]);
        expect(isSwarmRunActive("held")).toBe(true);
        releaseSwarmRun("held");
        await flushMicrotasks();
        expect(started).toEqual(["foreign", "held", "next"]);
      } finally {
        first?.release();
        second?.release();
      }
    },
  );

  it.each(["same", "replacement"])(
    "does not let stale holds withdraw a reused id in a %s lane",
    async (group) => {
      const oldStart = vi.fn(async () => {});
      enqueueSwarmRun({
        groupId: "same",
        runId: "reused",
        maxConcurrent: 1,
        activeRunIds: [],
        start: oldStart,
        onStartFailure: () => true,
      });
      const hold = holdQueuedSwarmRun("reused");
      expect(hold).toBeDefined();
      expect(hold?.withdraw()).toBe(true);
      expect(isSwarmRunActive("reused")).toBe(false);
      const nextStart = vi.fn(async () => {});
      enqueueSwarmRun({
        groupId: group,
        runId: "reused",
        maxConcurrent: 1,
        activeRunIds: [],
        start: nextStart,
        onStartFailure: () => true,
      });
      expect(hold?.withdraw()).toBe(false);
      hold?.release();
      await flushMicrotasks();
      expect(oldStart).not.toHaveBeenCalled();
      expect(nextStart).toHaveBeenCalledOnce();
      expect(hold?.withdraw()).toBe(false);
      expect(releaseSwarmRun("reused")).toBe(true);
    },
  );
});
