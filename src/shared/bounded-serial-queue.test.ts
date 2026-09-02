import { describe, expect, it, vi } from "vitest";
import { BoundedSerialQueue } from "./bounded-serial-queue.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("BoundedSerialQueue", () => {
  it("runs one task at a time in FIFO order and continues after failures", async () => {
    const first = deferred();
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
    const first = deferred();
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
    const first = deferred();
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
    const first = deferred();
    const second = deferred();
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

  it("can require every task in the accepted prefix to succeed", async () => {
    const failure = new Error("persistence failed");
    const queue = new BoundedSerialQueue({ maxPendingCount: 1, maxPendingWeight: 1 });
    const task = queue.enqueue(async () => {
      throw failure;
    });
    const ordinaryFlush = queue.flush();
    const strictFlush = queue.flush({ requireSuccess: true });

    await expect(ordinaryFlush).resolves.toBeUndefined();
    await expect(strictFlush).rejects.toBe(failure);
    if (task.accepted) {
      await expect(task.completion).rejects.toBe(failure);
    }
  });

  it("seals idempotently while preserving accepted work", async () => {
    const first = deferred();
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
