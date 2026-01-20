import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diag: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../logging/diagnostic.js", () => ({
  logLaneEnqueue: diagnosticMocks.logLaneEnqueue,
  logLaneDequeue: diagnosticMocks.logLaneDequeue,
  diagnosticLogger: diagnosticMocks.diag,
}));

import { enqueueCommand, getQueueSize } from "./command-queue.js";

describe("command queue", () => {
  beforeEach(() => {
    diagnosticMocks.logLaneEnqueue.mockClear();
    diagnosticMocks.logLaneDequeue.mockClear();
    diagnosticMocks.diag.debug.mockClear();
    diagnosticMocks.diag.warn.mockClear();
    diagnosticMocks.diag.error.mockClear();
  });

  it("runs tasks one at a time in order", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: number[] = [];

    const makeTask = (id: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(id);
      await new Promise((resolve) => setTimeout(resolve, 15));
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

    // First task holds the queue long enough to trigger wait notice.
    const first = enqueueCommand(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const second = enqueueCommand(async () => {}, {
      warnAfterMs: 5,
      onWait: (ms, ahead) => {
        waited = ms;
        queuedAhead = ahead;
      },
    });

    await Promise.all([first, second]);

    expect(waited).not.toBeNull();
    expect(waited as number).toBeGreaterThanOrEqual(5);
    expect(queuedAhead).toBe(0);
  });
});
