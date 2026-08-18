import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateSwarmRun,
  enqueueSwarmRun,
  isSwarmRunQueued,
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

    expect(
      enqueueSwarmRun({
        groupId: "group",
        runId: "one",
        maxConcurrent: 1,
        activeRunIds: [],
        start: start("one"),
        onStartFailure,
      }),
    ).toBe("started");
    expect(
      enqueueSwarmRun({
        groupId: "group",
        runId: "two",
        maxConcurrent: 1,
        activeRunIds: [],
        start: start("two"),
        onStartFailure,
      }),
    ).toBe("queued");
    expect(
      enqueueSwarmRun({
        groupId: "group",
        runId: "three",
        maxConcurrent: 1,
        activeRunIds: [],
        start: start("three"),
        onStartFailure,
      }),
    ).toBe("queued");

    await vi.waitFor(() => expect(started).toEqual(["one"]));
    expect(releaseSwarmRun("one")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
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
    expect(activate("two")).toBe("queued");
    await Promise.resolve();
    expect(started).toEqual([]);

    expect(activate("one")).toBe("started");
    await vi.waitFor(() => expect(started).toEqual(["one"]));
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
    expect(removeQueuedSwarmRun("two")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["one"]));
    releaseSwarmRun("one");
    await vi.waitFor(() => expect(started).toEqual(["one", "three"]));
  });

  it("tracks restored active and queued runs across independent groups", () => {
    expect(
      reserveSwarmRun({
        groupId: "restored-group",
        runId: "queued",
        maxConcurrent: 1,
        activeRunIds: ["restored-active"],
      }),
    ).toBe(true);
    expect(
      reserveSwarmRun({
        groupId: "other-group",
        runId: "other-queued",
        maxConcurrent: 1,
        activeRunIds: [],
      }),
    ).toBe(true);

    expect(isSwarmRunQueued("queued")).toBe(true);
    expect(isSwarmRunQueued("other-queued")).toBe(true);
    expect(releaseSwarmRun("restored-active")).toBe(true);
    expect(removeQueuedSwarmRun("other-queued")).toBe(true);
    expect(isSwarmRunQueued("queued")).toBe(true);
    expect(isSwarmRunQueued("other-queued")).toBe(false);
    expect(removeQueuedSwarmRun("queued")).toBe(true);
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
    expect(
      activateSwarmRun({
        groupId: "group",
        runId: "queued",
        start: async () => {
          started.push("queued");
        },
        onStartFailure: vi.fn(() => true),
      }),
    ).toBe("started");
    await vi.waitFor(() => expect(started).toEqual(["queued"]));
    expect(isSwarmRunQueued("next")).toBe(true);
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
    enqueue("four", 1);
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));

    releaseSwarmRun("one");
    await Promise.resolve();
    expect(started).toEqual(["one", "two"]);
    releaseSwarmRun("two");
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
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

    expect(
      enqueueSwarmRun({
        groupId: "group",
        runId: "reused",
        maxConcurrent: 2,
        activeRunIds: [],
        start: async () => {
          reusedAttempts += 1;
        },
        onStartFailure: vi.fn(() => true),
      }),
    ).toBe("started");
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
});
