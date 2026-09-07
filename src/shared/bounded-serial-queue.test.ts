import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { BoundedSerialQueue } from "./bounded-serial-queue.js";

describe("BoundedSerialQueue", () => {
  it("runs one task at a time in FIFO order and continues after failures", async () => {
    const first = createDeferred();
    const order: string[] = [];
    const queue = new BoundedSerialQueue({ maxPendingCount: 4, maxPendingWeight: 4 });

    const one = queue.enqueue(async () => {
      order.push("one:start");
      await first.promise;
      order.push("one:end");
    });
    const failure = new Error("second failed");
    const two = queue.enqueue(async () => {
      order.push("two");
      throw failure;
    });
    const three = queue.enqueue(async () => {
      order.push("three");
      return 3;
    });

    expect(one.accepted && two.accepted && three.accepted).toBe(true);
    expect(order).toEqual(["one:start"]);
    const oneCompletion = expect(
      one.accepted ? one.completion : Promise.reject(new Error("first task was not admitted")),
    ).resolves.toBeUndefined();
    const twoCompletion = expect(two.accepted ? two.completion : Promise.resolve()).rejects.toBe(
      failure,
    );
    const threeCompletion = expect(
      three.accepted ? three.completion : Promise.reject(new Error("third task was not admitted")),
    ).resolves.toBe(3);
    first.resolve();

    await Promise.all([oneCompletion, twoCompletion, threeCompletion]);
    expect(order).toEqual(["one:start", "one:end", "two", "three"]);
    expect(queue.isIdle).toBe(true);
  });

  it("bounds waiting count and weight, then seals on the first overflow", () => {
    const first = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 2, maxPendingWeight: 5 });
    const active = queue.enqueue(async () => await first.promise, { weight: 100 });
    const waiting = queue.enqueue(async () => undefined, { weight: 3 });
    const overflow = queue.enqueue(async () => undefined, { weight: 3 });
    const late = queue.enqueue(async () => undefined);

    expect(active.accepted).toBe(true);
    expect(waiting.accepted).toBe(true);
    expect(overflow).toEqual({ accepted: false, reason: "overflow" });
    expect(late).toEqual({ accepted: false, reason: "sealed" });
    expect(queue.didOverflow).toBe(true);
    first.resolve();
  });

  it("can reject at capacity without sealing admission", async () => {
    const first = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 1, maxPendingWeight: 1 });
    const active = queue.enqueue(async () => await first.promise);
    const waiting = queue.enqueue(async () => undefined);

    expect(
      queue.enqueue(async () => undefined, {
        sealOnOverflow: false,
      }),
    ).toEqual({ accepted: false, reason: "capacity" });
    expect(queue.didOverflow).toBe(false);

    first.resolve();
    await queue.flush();
    const afterDrain = queue.enqueue(async () => "accepted");
    expect(afterDrain.accepted).toBe(true);
    if (afterDrain.accepted) {
      await expect(afterDrain.completion).resolves.toBe("accepted");
    }
    if (active.accepted) {
      await active.completion;
    }
    if (waiting.accepted) {
      await waiting.completion;
    }
  });

  it("flushes only the accepted prefix visible at call time", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 2, maxPendingWeight: 2 });
    const active = queue.enqueue(async () => await first.promise);
    const flush = queue.flush();
    expect(queue.flush()).toBe(flush);
    const late = queue.enqueue(async () => await second.promise);
    const flushed = vi.fn();
    void flush.then(flushed);

    first.resolve();
    await flush;

    expect(flushed).toHaveBeenCalledOnce();
    expect(late.accepted && queue.isIdle).toBe(false);
    second.resolve();
    await queue.flush();
    expect(queue.isIdle).toBe(true);
    if (active.accepted) {
      await active.completion;
    }
    if (late.accepted) {
      await late.completion;
    }
  });

  it.each([new Error("persistence failed"), undefined])(
    "preserves the first failure (%s) in a sealed prefix",
    async (failure) => {
      const queue = new BoundedSerialQueue({ maxPendingCount: 1, maxPendingWeight: 1 });
      const first = createDeferred();
      const task = queue.enqueue(() => first.promise);
      const laterFailure = new Error("later failure");
      const later = queue.enqueue(() => {
        throw laterFailure;
      });
      queue.seal();
      const ordinaryFlush = queue.flush();
      const strictFlush = queue.flush({ requireSuccess: true });

      first.reject(failure);
      await Promise.all([
        expect(ordinaryFlush).resolves.toBeUndefined(),
        expect(strictFlush).rejects.toBe(failure),
        expect(task.accepted ? task.completion : Promise.resolve()).rejects.toBe(failure),
        expect(later.accepted ? later.completion : Promise.resolve()).rejects.toBe(laterFailure),
      ]);
      expect(queue.isIdle).toBe(true);
    },
  );

  it("does not reject a successful flush prefix for a later synchronous failure", async () => {
    const first = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 1, maxPendingWeight: 1 });
    const active = queue.enqueue(() => first.promise);
    const prefix = queue.flush({ requireSuccess: true });
    const failure = new Error("outside the captured prefix");
    const later = queue.enqueue(() => {
      throw failure;
    });
    const laterFailure = expect(later.accepted ? later.completion : Promise.resolve()).rejects.toBe(
      failure,
    );

    first.resolve();

    await Promise.all([expect(prefix).resolves.toBeUndefined(), laterFailure]);
    await expect(queue.flush({ requireSuccess: true })).rejects.toBe(failure);
    if (active.accepted) {
      await active.completion;
    }
    expect(queue.isIdle).toBe(true);
  });

  it("seals idempotently while preserving accepted work", async () => {
    const first = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 1, maxPendingWeight: 1 });
    const active = queue.enqueue(async () => await first.promise);
    const waiting = queue.enqueue(async () => "done");

    queue.seal();
    queue.seal();
    expect(queue.enqueue(async () => undefined)).toEqual({ accepted: false, reason: "sealed" });
    first.resolve();
    await queue.flush();

    expect(active.accepted && waiting.accepted).toBe(true);
    if (waiting.accepted) {
      await expect(waiting.completion).resolves.toBe("done");
    }
  });
});
