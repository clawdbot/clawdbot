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
    const taskError = new Error("boom");
    const setStatus = vi.fn();
    const onError = vi.fn();
    const queue = createChannelRunQueue({ setStatus, onError });

    queue.enqueue("key", async () => {
      throw taskError;
    });

    await flushAsyncWork();

    expect(setStatus).toHaveBeenCalledTimes(3);
    const [initialStatus, busyStatus, finalStatus] = setStatus.mock.calls.map(([status]) => status);
    expect(initialStatus).toEqual({ activeRuns: 0, busy: false });
    expect(busyStatus?.activeRuns).toBe(1);
    expect(busyStatus?.busy).toBe(true);
    expect(typeof busyStatus?.lastRunActivityAt).toBe("number");
    expect(finalStatus?.activeRuns).toBe(0);
    expect(finalStatus?.busy).toBe(false);
    expect(typeof finalStatus?.lastRunActivityAt).toBe("number");
    expect(onError).toHaveBeenCalledWith(taskError);
  });

  it("contains reporting hook errors", async () => {
    const taskError = new Error("boom");
    const onError = vi.fn(() => {
      throw new Error("report failed");
    });
    const queue = createChannelRunQueue({
      onError,
    });

    queue.enqueue("key", async () => {
      throw taskError;
    });

    await flushAsyncWork();
    expect(onError).toHaveBeenCalledWith(taskError);
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
