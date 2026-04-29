import { describe, expect, it, vi } from "vitest";
import { createChannelRunQueue } from "./channel-lifecycle.core.js";

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushAsyncWork() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe("createChannelRunQueue", () => {
  it("serializes work per key while allowing unrelated keys to run", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const third = createDeferred();
    const order: string[] = [];
    const queue = createChannelRunQueue({});

    queue.enqueue("same", async () => {
      order.push("start:first");
      await first.promise;
      order.push("end:first");
    });
    queue.enqueue("same", async () => {
      order.push("start:second");
      await second.promise;
      order.push("end:second");
    });
    queue.enqueue("other", async () => {
      order.push("start:third");
      await third.promise;
      order.push("end:third");
    });

    await flushAsyncWork();
    expect(order).toEqual(["start:first", "start:third"]);

    third.resolve?.();
    await third.promise;
    await flushAsyncWork();
    expect(order).toEqual(["start:first", "start:third", "end:third"]);

    first.resolve?.();
    await first.promise;
    await flushAsyncWork();
    expect(order).toEqual(["start:first", "start:third", "end:third", "end:first", "start:second"]);

    second.resolve?.();
    await second.promise;
  });

  it("updates run status and routes async errors", async () => {
    const setStatus = vi.fn();
    const onError = vi.fn();
    const queue = createChannelRunQueue({ setStatus, onError });

    queue.enqueue("key", async () => {
      throw new Error("boom");
    });

    await flushAsyncWork();

    expect(setStatus).toHaveBeenCalledWith({ activeRuns: 0, busy: false });
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ activeRuns: 1, busy: true }));
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeRuns: 0, busy: false }),
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("contains reporting hook errors", async () => {
    const queue = createChannelRunQueue({
      onError: () => {
        throw new Error("report failed");
      },
    });

    queue.enqueue("key", async () => {
      throw new Error("boom");
    });

    await flushAsyncWork();
  });

  it("skips queued work after deactivation", async () => {
    const first = createDeferred();
    const task = vi.fn();
    const queue = createChannelRunQueue({});

    queue.enqueue("key", async () => {
      await first.promise;
    });
    queue.enqueue("key", task);
    await flushAsyncWork();

    queue.deactivate();
    first.resolve?.();
    await first.promise;
    await flushAsyncWork();

    expect(task).not.toHaveBeenCalled();
  });
});
