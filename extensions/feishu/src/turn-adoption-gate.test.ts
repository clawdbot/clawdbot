// Feishu tests cover the turn adoption gate and adoption-gated queue tasks.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import { createSequentialQueue } from "./sequential-queue.js";
import { createTurnAdoptionGate, enqueueAdoptionGatedTurn } from "./turn-adoption-gate.js";

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

describe("createTurnAdoptionGate", () => {
  it("releases the gate only after the original adoption settles", async () => {
    const { lifecycle, calls } = createLifecycle();
    let finishAdoption!: () => void;
    calls.adopted.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishAdoption = resolve;
      });
    });
    const { lifecycle: wrapped, gate } = createTurnAdoptionGate(lifecycle);
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let gateOpened = false;
    void gate.then(() => {
      gateOpened = true;
    });
    const adoption = wrapped.onAdopted();
    await Promise.resolve();
    await Promise.resolve();
    expect(gateOpened).toBe(false);
    finishAdoption();
    await adoption;
    expect(gateOpened).toBe(true);
  });

  it("releases the gate and propagates when the original adoption rejects", async () => {
    const { lifecycle, calls } = createLifecycle();
    calls.adopted.mockRejectedValueOnce(new Error("adopt failed"));
    const { lifecycle: wrapped, gate } = createTurnAdoptionGate(lifecycle);
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let gateOpened = false;
    void gate.then(() => {
      gateOpened = true;
    });
    await expect(wrapped.onAdopted()).rejects.toThrow("adopt failed");
    expect(gateOpened).toBe(true);
  });

  it("releases the gate on deferral and preserves the accepted flag", async () => {
    const { lifecycle, calls } = createLifecycle();
    calls.deferred.mockReturnValue(false);
    const { lifecycle: wrapped, gate } = createTurnAdoptionGate(lifecycle);
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let gateOpened = false;
    void gate.then(() => {
      gateOpened = true;
    });
    expect(wrapped.onDeferred()).toBe(false);
    await gate;
    expect(gateOpened).toBe(true);
  });

  it("releases the gate on failure when the lifecycle reports one", async () => {
    const { lifecycle } = createLifecycle();
    const failed = vi.fn(async () => {});
    const { lifecycle: wrapped, gate } = createTurnAdoptionGate({
      ...lifecycle,
      onFailed: failed,
    });
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let gateOpened = false;
    void gate.then(() => {
      gateOpened = true;
    });
    await wrapped.onFailed?.(new Error("failed"));
    expect(gateOpened).toBe(true);
  });

  it("releases the gate on abandon", async () => {
    const { lifecycle } = createLifecycle();
    const { lifecycle: wrapped, gate } = createTurnAdoptionGate(lifecycle);
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let gateOpened = false;
    void gate.then(() => {
      gateOpened = true;
    });
    await wrapped.onAbandoned();
    expect(gateOpened).toBe(true);
  });

  it("releases once across repeated terminal signals", async () => {
    const { lifecycle, controller } = createLifecycle();
    const { lifecycle: wrapped, gate } = createTurnAdoptionGate(lifecycle);
    if (!wrapped) {
      throw new Error("expected a wrapped lifecycle");
    }
    let gateOpenings = 0;
    void gate.then(() => {
      gateOpenings += 1;
    });
    await wrapped.onAdopted();
    controller.abort(new Error("late abort"));
    await wrapped.onAbandoned();
    expect(gateOpenings).toBe(1);
  });

  it("releases the gate immediately when the signal is already aborted", async () => {
    const { lifecycle, controller } = createLifecycle();
    controller.abort(new Error("pre-start abort"));
    const { gate } = createTurnAdoptionGate(lifecycle);
    await expect(gate).resolves.toBeUndefined();
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

  it("releases the queue lane when the ingress abort signal fires", async () => {
    const { lifecycle, controller } = createLifecycle();
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

  it("settles the turn even when a pre-start abandon rejects", async () => {
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
    await expect(turn).resolves.toBeUndefined();
    await expect(lane).rejects.toThrow("abandon failed");
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
