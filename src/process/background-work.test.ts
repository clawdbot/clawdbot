import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createBackgroundWorkOwner, getBackgroundWorkSnapshot } from "./background-work.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  markGatewayDraining,
  resetAllLanes,
} from "./command-queue.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import { getGatewayRestartDrainSignal } from "./gateway-work-admission.js";
import { CommandLane } from "./lanes.js";

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("background work admission", () => {
  beforeEach(resetCommandQueueStateForTest);
  afterEach(resetCommandQueueStateForTest);

  it("shares three slots, preserves owner widths and FIFO, and leaves foreground capacity free", async () => {
    const parallel = createBackgroundWorkOwner({ owner: "plugin:parallel", maxConcurrent: 3 });
    const serial = createBackgroundWorkOwner({ owner: "core:serial", maxConcurrent: 1 });
    const gates = Array.from({ length: 3 }, () => createDeferred());
    const parallelRuns = gates.map((gate) => parallel.enqueue(async () => await gate.promise));
    const serialGate = createDeferred();
    const order: number[] = [];
    const first = serial.enqueue(async () => {
      order.push(1);
      await serialGate.promise;
    });
    const second = serial.enqueue(async () => {
      order.push(2);
    });
    try {
      expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 3, queuedCount: 2 });
      await expect(enqueueCommandInLane(CommandLane.Main, async () => "foreground")).resolves.toBe(
        "foreground",
      );
      gates[0]!.resolve();
      await parallelRuns[0];
      expect(order).toEqual([1]);
      expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 3, queuedCount: 1 });
      gates[1]!.resolve();
      gates[2]!.resolve();
      await Promise.all(parallelRuns);
      expect(getCommandLaneSnapshot(serial.lane)).toMatchObject({ activeCount: 1, queuedCount: 1 });
      serialGate.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual([1, 2]);
    } finally {
      gates.forEach((gate) => gate.resolve());
      serialGate.resolve();
      await Promise.all([...parallelRuns, first, second]);
    }
  });

  it("removes cancelled work immediately without invoking it or reordering its successors", async () => {
    const owner = createBackgroundWorkOwner({ owner: "core:cancel", maxConcurrent: 1 });
    const gate = createDeferred();
    const active = owner.enqueue(async () => await gate.promise);
    const controller = new AbortController();
    const cancelledTask = vi.fn(async () => undefined);
    const order: number[] = [];
    const first = owner.enqueue(async () => {
      order.push(1);
    });
    const cancelled = owner.enqueue(cancelledTask, { abortSignal: controller.signal });
    const last = owner.enqueue(async () => {
      order.push(2);
    });
    const rejection = expect(cancelled).rejects.toThrow("cancel background work");
    controller.abort(new Error("cancel background work"));
    await rejection;
    expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 1, queuedCount: 2 });
    gate.resolve();
    await Promise.all([active, first, last]);
    expect(cancelledTask).not.toHaveBeenCalled();
    expect(order).toEqual([1, 2]);
  });

  it.each(["drain", "reset"])(
    "cancels old work on restart %s and admits fresh work",
    async (restart) => {
      const owner = createBackgroundWorkOwner({ owner: "core:restart", maxConcurrent: 1 });
      const started = createDeferred();
      const active = owner.enqueue(async (signal) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      });
      await started.promise;
      const staleTask = vi.fn(async () => undefined);
      const stale = owner.enqueue(staleTask);
      const oldSignal = getGatewayRestartDrainSignal();
      const activeRejected = expect(active).rejects.toThrow(/draining for restart|runtime reset/u);
      const staleRejected = expect(stale).rejects.toThrow(/draining for restart|runtime reset/u);
      if (restart === "drain") {
        markGatewayDraining();
      } else {
        resetAllLanes();
      }
      await Promise.all([activeRejected, staleRejected]);
      resetAllLanes();
      expect(oldSignal.aborted).toBe(true);
      expect(getGatewayRestartDrainSignal().aborted).toBe(false);
      await expect(owner.enqueue(async () => "fresh")).resolves.toBe("fresh");
      expect(staleTask).not.toHaveBeenCalled();
      expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 0, queuedCount: 0 });
    },
  );
});
