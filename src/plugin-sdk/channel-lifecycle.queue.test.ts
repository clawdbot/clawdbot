/**
 * Tests channel lifecycle queue ordering and failure handling.
 */
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
    expect(initialStatus).toEqual({ activeRuns: 0, busy: false, activeRunStartedAt: null });
    expect(busyStatus?.activeRuns).toBe(1);
    expect(busyStatus?.busy).toBe(true);
    expect(typeof busyStatus?.lastRunActivityAt).toBe("number");
    expect(typeof busyStatus?.activeRunStartedAt).toBe("number");
    expect(finalStatus?.activeRuns).toBe(0);
    expect(finalStatus?.busy).toBe(false);
    expect(typeof finalStatus?.lastRunActivityAt).toBe("number");
    expect(finalStatus?.activeRunStartedAt).toBeNull();
    expect(onError).toHaveBeenCalledWith(taskError);
  });

  it("keeps the oldest run start while a newer concurrent task completes", async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred();
      const second = createDeferred();
      const setStatus = vi.fn();
      const queue = createChannelRunQueue({ setStatus });

      vi.setSystemTime(1_000);
      queue.enqueue("first", async () => {
        await first.promise;
      });
      await flushAsyncWork();

      vi.setSystemTime(2_000);
      queue.enqueue("second", async () => {
        await second.promise;
      });
      await flushAsyncWork();

      second.resolve?.();
      await second.promise;
      await flushAsyncWork();

      expect(setStatus.mock.calls.at(-1)?.[0]).toMatchObject({
        activeRuns: 1,
        busy: true,
        activeRunStartedAt: 1_000,
      });

      queue.deactivate();
      first.resolve?.();
      await first.promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances to the next-oldest run start when the oldest run ends", async () => {
    vi.useFakeTimers();
    try {
      const first = createDeferred();
      const second = createDeferred();
      const setStatus = vi.fn();
      const queue = createChannelRunQueue({ setStatus });

      vi.setSystemTime(1_000);
      queue.enqueue("first", async () => {
        await first.promise;
      });
      await flushAsyncWork();

      vi.setSystemTime(2_000);
      queue.enqueue("second", async () => {
        await second.promise;
      });
      await flushAsyncWork();

      first.resolve?.();
      await first.promise;
      await flushAsyncWork();

      expect(setStatus.mock.calls.at(-1)?.[0]).toMatchObject({
        activeRuns: 1,
        busy: true,
        activeRunStartedAt: 2_000,
      });

      queue.deactivate();
      second.resolve?.();
      await second.promise;
    } finally {
      vi.useRealTimers();
    }
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
