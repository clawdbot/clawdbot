// Feishu tests cover the turn adoption gate and adoption-gated queue tasks.
// The gate itself is not exported: tests drive the wrapper lifecycle through
// the production entry enqueueAdoptionGatedTurn, which hands it to runTurn.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import { createSequentialQueue } from "./sequential-queue.js";
import { enqueueAdoptionGatedTurn } from "./turn-adoption-gate.js";

function createLifecycle() {
  const controller = new AbortController();
  const calls = {
    adopted: vi.fn(async () => {}),
    deferred: vi.fn((): boolean | void => undefined),
    finalizing: vi.fn(),
    abandoned: vi.fn(async () => {}),
  };
  const lifecycle: FeishuIngressLifecycle = {
    abortSignal: controller.signal,
    onAdopted: calls.adopted,
    onDeferred: calls.deferred,
    onAdoptionFinalizing: calls.finalizing,
    onAbandoned: calls.abandoned,
  };
  return { calls, controller, lifecycle };
}

function createQueue() {
  return createSequentialQueue();
}

// Enqueues through the production entry and captures the wrapped lifecycle
// from runTurn, so the gate is exercised exactly as the handlers use it. The
// enqueue mock schedules the task on a later microtask, like the real
// sequential queue, so the helper's own `turn` binding exists when the task
// runs.
function driveGate(params: { lifecycle?: FeishuIngressLifecycle }) {
  const captured: { wrapped: FeishuIngressLifecycle | undefined } = { wrapped: undefined };
  const turnGate = createDeferred<void>();
  const { lane, turn } = enqueueAdoptionGatedTurn({
    enqueue: (key, task) => Promise.resolve().then(() => task()),
    sequentialKey: "feishu:default:oc-chat",
    lifecycle: params.lifecycle,
    runTurn: async (gated) => {
      captured.wrapped = gated;
      await turnGate.promise;
    },
  });
  return {
    lane,
    turn,
    getWrapped: async () => {
      await vi.waitFor(() => expect(captured.wrapped).toBeDefined());
      return captured.wrapped;
    },
    finishTurn: () => turnGate.resolve(),
  };
}

describe("turn adoption gate (driven through enqueueAdoptionGatedTurn)", () => {
  it("releases the lane only after the original adoption settles", async () => {
    const { lifecycle, calls } = createLifecycle();
    let finishAdoption!: () => void;
    calls.adopted.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishAdoption = resolve;
      });
    });
    const harness = driveGate({ lifecycle });
    const wrapped = await harness.getWrapped();
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let laneOpened = false;
    void harness.lane.then(() => {
      laneOpened = true;
    });
    const adoption = wrapped.onAdopted();
    await Promise.resolve();
    await Promise.resolve();
    expect(laneOpened).toBe(false);
    finishAdoption();
    await adoption;
    await harness.lane;
    expect(laneOpened).toBe(true);
    harness.finishTurn();
    await harness.turn;
  });

  it("rejects the lane when the original adoption rejects", async () => {
    const { lifecycle, calls } = createLifecycle();
    calls.adopted.mockRejectedValueOnce(new Error("adopt failed"));
    const harness = driveGate({ lifecycle });
    const wrapped = await harness.getWrapped();
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    await expect(wrapped.onAdopted()).rejects.toThrow("adopt failed");
    // The carried failure is the original error: the lane rejects with it so
    // the flush's catch → onAbandoned → rethrow → onError path runs.
    await expect(harness.lane).rejects.toThrow("adopt failed");
    harness.finishTurn();
    await harness.turn;
  });

  it("releases the lane on deferral and preserves the accepted flag", async () => {
    const { lifecycle, calls } = createLifecycle();
    calls.deferred.mockReturnValue(false);
    const harness = driveGate({ lifecycle });
    const wrapped = await harness.getWrapped();
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let laneOpened = false;
    void harness.lane.then(() => {
      laneOpened = true;
    });
    expect(wrapped.onDeferred()).toBe(false);
    await harness.lane;
    expect(laneOpened).toBe(true);
    harness.finishTurn();
    await harness.turn;
  });

  it("releases the lane on failure when the lifecycle reports one", async () => {
    const { lifecycle } = createLifecycle();
    const failed = vi.fn(async () => {});
    const harness = driveGate({ lifecycle: { ...lifecycle, onFailed: failed } });
    const wrapped = await harness.getWrapped();
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let laneOpened = false;
    void harness.lane.then(() => {
      laneOpened = true;
    });
    await wrapped.onFailed?.(new Error("failed"));
    await harness.lane;
    expect(laneOpened).toBe(true);
    harness.finishTurn();
    await harness.turn;
  });

  it("releases the lane on abandon", async () => {
    const { lifecycle, calls } = createLifecycle();
    const harness = driveGate({ lifecycle });
    const wrapped = await harness.getWrapped();
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let laneOpened = false;
    void harness.lane.then(() => {
      laneOpened = true;
    });
    await wrapped.onAbandoned();
    await harness.lane;
    expect(laneOpened).toBe(true);
    expect(calls.abandoned).toHaveBeenCalledTimes(1);
    harness.finishTurn();
    await harness.turn;
  });

  it("releases the lane once across repeated terminal signals", async () => {
    const { lifecycle, controller } = createLifecycle();
    const harness = driveGate({ lifecycle });
    const wrapped = await harness.getWrapped();
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let laneOpenings = 0;
    void harness.lane.then(() => {
      laneOpenings += 1;
    });
    await wrapped.onAdopted();
    await harness.lane;
    controller.abort(new Error("late abort"));
    await wrapped.onAbandoned();
    expect(laneOpenings).toBe(1);
    harness.finishTurn();
    await harness.turn;
  });

  it("releases the lane immediately when the signal is already aborted", async () => {
    const { lifecycle, controller, calls } = createLifecycle();
    controller.abort(new Error("pre-start abort"));
    const harness = driveGate({ lifecycle });
    await harness.lane;
    expect(calls.abandoned).toHaveBeenCalledTimes(1);
    harness.finishTurn();
    await harness.turn;
  });
});

describe("enqueueAdoptionGatedTurn", () => {
  it("releases the queue lane at adoption while the turn is still running", async () => {
    const { lifecycle, calls } = createLifecycle();
    const turnGate = createDeferred<void>();
    const order: string[] = [];
    const { lane, turn } = enqueueAdoptionGatedTurn({
      enqueue: createQueue(),
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async (gated) => {
        order.push("turn:start");
        gated?.onAdoptionFinalizing();
        await gated?.onAdopted();
        order.push("turn:adopted");
        await turnGate.promise;
        order.push("turn:end");
      },
    });
    await vi.waitFor(() => expect(order).toEqual(["turn:start", "turn:adopted"]));
    await lane;
    expect(order).toEqual(["turn:start", "turn:adopted"]);
    expect(calls.adopted).toHaveBeenCalledTimes(1);
    turnGate.resolve();
    await turn;
    expect(order).toEqual(["turn:start", "turn:adopted", "turn:end"]);
  });

  it("rejects the lane when adoption fails while the turn is still pending", async () => {
    const { lifecycle, calls } = createLifecycle();
    calls.adopted.mockRejectedValueOnce(new Error("adopt failed"));
    const turnGate = createDeferred<void>();
    const order: string[] = [];
    const { lane, turn } = enqueueAdoptionGatedTurn({
      enqueue: createQueue(),
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async (gated) => {
        order.push("turn:start");
        gated?.onAdoptionFinalizing();
        // The real dispatcher runs the adoption several promise hops deep:
        // the lane settles before the turn's rejection lands, so a gate that
        // releases a failed adoption as success would let the flush settle.
        const adoption = gated?.onAdopted() ?? Promise.resolve();
        void adoption.catch(() => undefined);
        await turnGate.promise;
        await adoption;
      },
    });
    await vi.waitFor(() => expect(order).toEqual(["turn:start"]));
    await expect(lane).rejects.toThrow("adopt failed");
    expect(calls.abandoned).not.toHaveBeenCalled();
    turnGate.resolve();
    await expect(turn).rejects.toThrow("adopt failed");
  });

  it("releases the queue lane at deferral while the turn is still running", async () => {
    const { lifecycle } = createLifecycle();
    const turnGate = createDeferred<void>();
    const order: string[] = [];
    const { lane, turn } = enqueueAdoptionGatedTurn({
      enqueue: createQueue(),
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async (gated) => {
        order.push("turn:start");
        gated?.onDeferred();
        order.push("turn:deferred");
        await turnGate.promise;
        order.push("turn:end");
      },
    });
    await vi.waitFor(() => expect(order).toEqual(["turn:start", "turn:deferred"]));
    await lane;
    expect(order).toEqual(["turn:start", "turn:deferred"]);
    turnGate.resolve();
    await turn;
    expect(order).toEqual(["turn:start", "turn:deferred", "turn:end"]);
  });

  it("releases the queue lane at abandon", async () => {
    const { lifecycle, calls } = createLifecycle();
    const turnGate = createDeferred<void>();
    const order: string[] = [];
    const { lane, turn } = enqueueAdoptionGatedTurn({
      enqueue: createQueue(),
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async (gated) => {
        order.push("turn:start");
        await gated?.onAbandoned();
        order.push("turn:abandoned");
        await turnGate.promise;
        order.push("turn:end");
      },
    });
    await vi.waitFor(() => expect(order).toEqual(["turn:start", "turn:abandoned"]));
    await lane;
    expect(order).toEqual(["turn:start", "turn:abandoned"]);
    expect(calls.abandoned).toHaveBeenCalledTimes(1);
    turnGate.resolve();
    await turn;
    expect(order).toEqual(["turn:start", "turn:abandoned", "turn:end"]);
  });

  it("abandons the durable claim and releases the lane when the ingress abort signal fires", async () => {
    const { lifecycle, controller, calls } = createLifecycle();
    const turnGate = createDeferred<void>();
    let started = false;
    const { lane, turn } = enqueueAdoptionGatedTurn({
      enqueue: createQueue(),
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async () => {
        started = true;
        await turnGate.promise;
      },
    });
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort(new Error("adoption stall"));
    await lane;
    expect(started).toBe(true);
    // A pre-adoption abort must abandon the durable claim before the lane
    // frees: releasing the lane as success would let the flush settle the
    // row as adopted and drop the message on shutdown.
    expect(calls.abandoned).toHaveBeenCalledTimes(1);
    turnGate.resolve();
    await turn;
  });

  it("rejects the lane when the pre-adoption abort's abandonment fails", async () => {
    const { lifecycle, controller, calls } = createLifecycle();
    calls.abandoned.mockRejectedValueOnce(new Error("abandon failed"));
    const turnGate = createDeferred<void>();
    let started = false;
    const { lane, turn } = enqueueAdoptionGatedTurn({
      enqueue: createQueue(),
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async () => {
        started = true;
        await turnGate.promise;
      },
    });
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort(new Error("monitor shutdown"));
    // A failed abandonment must reject the lane so the flush's catch retries
    // the abandonment and surfaces the error, instead of settling the flush.
    await expect(lane).rejects.toThrow("abandon failed");
    turnGate.resolve();
    await turn;
  });

  it("waits for the full turn when no lifecycle is provided", async () => {
    const turnGate = createDeferred<void>();
    const order: string[] = [];
    const { lane, turn } = enqueueAdoptionGatedTurn({
      enqueue: createQueue(),
      sequentialKey: "feishu:default:oc-chat",
      lifecycle: undefined,
      runTurn: async (gated) => {
        expect(gated).toBeUndefined();
        order.push("turn:start");
        await turnGate.promise;
        order.push("turn:end");
      },
    });
    await vi.waitFor(() => expect(order).toEqual(["turn:start"]));
    let laneResolved = false;
    void lane.then(() => {
      laneResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(laneResolved).toBe(false);
    turnGate.resolve();
    await lane;
    await turn;
    expect(order).toEqual(["turn:start", "turn:end"]);
  });

  it("rejects the turn and the lane when a pre-start abandon fails", async () => {
    const { lifecycle, controller, calls } = createLifecycle();
    controller.abort(new Error("pre-start abort"));
    calls.abandoned.mockRejectedValueOnce(new Error("abandon failed"));
    const { lane, turn } = enqueueAdoptionGatedTurn({
      enqueue: createQueue(),
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async () => {
        throw new Error("must not run");
      },
    });
    // The flush observes outcomes through `turn`: an abandonment persistence
    // failure must reject the turn — settling it and carrying the failure in
    // the lane alone would let the flush's race resolve on the turn leg and
    // swallow the failure.
    await expect(turn).rejects.toThrow("abandon failed");
    await expect(lane).rejects.toThrow("abandon failed");
  });

  it("rejects the lane when adoption fails with a falsy value while the turn is still pending", async () => {
    const { lifecycle, calls } = createLifecycle();
    calls.adopted.mockRejectedValueOnce(undefined);
    const turnGate = createDeferred<void>();
    const order: string[] = [];
    const { lane, turn } = enqueueAdoptionGatedTurn({
      enqueue: createQueue(),
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async (gated) => {
        order.push("turn:start");
        gated?.onAdoptionFinalizing();
        // The real dispatcher runs the adoption several promise hops deep
        // (see the Error-valued sibling test); the gate settles before the
        // turn's rejection lands, so a falsy rejection released as success
        // would let the flush settle.
        const adoption = gated?.onAdopted() ?? Promise.resolve();
        void adoption.catch(() => undefined);
        await turnGate.promise;
        await adoption;
      },
    });
    await vi.waitFor(() => expect(order).toEqual(["turn:start"]));
    // `throw undefined` must still fail the lane: the outcome is tagged, so
    // a falsy rejection is never conflated with a success release.
    await expect(lane).rejects.toThrow("Feishu turn adoption failed");
    turnGate.resolve();
    await expect(turn).rejects.toBe(undefined);
  });

  it("keeps a second same-key task blocked until the first lane releases", async () => {
    const { lifecycle } = createLifecycle();
    const turnGate = createDeferred<void>();
    const order: string[] = [];
    const enqueue = createQueue();
    const first = enqueueAdoptionGatedTurn({
      enqueue,
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async (gated) => {
        order.push("first:start");
        await gated?.onAdopted();
        order.push("first:adopted");
        await turnGate.promise;
        order.push("first:end");
      },
    });
    const second = enqueueAdoptionGatedTurn({
      enqueue,
      sequentialKey: "feishu:default:oc-chat",
      lifecycle,
      runTurn: async () => {
        order.push("second:start");
      },
    });
    // The second task starts at the first lane's adoption release, while the
    // first turn is still running — and never before that release.
    await vi.waitFor(() => expect(order).toEqual(["first:start", "first:adopted", "second:start"]));
    turnGate.resolve();
    await Promise.all([first.turn, second.turn]);
    expect(order).toEqual(["first:start", "first:adopted", "second:start", "first:end"]);
  });
});
