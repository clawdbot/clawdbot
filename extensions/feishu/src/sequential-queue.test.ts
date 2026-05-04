import { describe, expect, it } from "vitest";
import { createSequentialQueue } from "./sequential-queue.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createSequentialQueue", () => {
  it("serializes tasks for the same key", async () => {
    const enqueue = createSequentialQueue();
    const gate = createDeferred();
    const order: string[] = [];

    const first = enqueue("feishu:default:chat-1", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = enqueue("feishu:default:chat-1", async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows different keys to run concurrently", async () => {
    const enqueue = createSequentialQueue();
    const gateA = createDeferred();
    const gateB = createDeferred();
    const order: string[] = [];

    const first = enqueue("feishu:default:chat-1", async () => {
      order.push("chat-1:start");
      await gateA.promise;
      order.push("chat-1:end");
    });
    const second = enqueue("feishu:default:chat-1:btw:om_2", async () => {
      order.push("btw:start");
      await gateB.promise;
      order.push("btw:end");
    });

    await Promise.resolve();
    expect(order).toEqual(["chat-1:start", "btw:start"]);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([first, second]);

    expect(order).toContain("chat-1:end");
    expect(order).toContain("btw:end");
  });

  it("does not leak unhandled rejections when a queued task fails", async () => {
    const enqueue = createSequentialQueue();
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(
        enqueue("feishu:default:chat-1", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);

      await expect(
        enqueue("feishu:default:chat-1", async () => {
          return;
        }),
      ).resolves.toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("evicts a stuck task after taskTimeoutMs so newer same-key work proceeds", async () => {
    const timeouts: Array<{ key: string; timeoutMs: number }> = [];
    const enqueue = createSequentialQueue({
      taskTimeoutMs: 25,
      onTaskTimeout: (key, timeoutMs) => {
        timeouts.push({ key, timeoutMs });
      },
    });
    const order: string[] = [];

    // Stuck task — never resolves until the test cleans up.
    const stuckGate = createDeferred();
    const stuck = enqueue("feishu:default:chat-stuck", async () => {
      order.push("stuck:start");
      await stuckGate.promise;
      order.push("stuck:end");
    });

    // Second same-key task — would be starved indefinitely without the cap.
    const followUp = enqueue("feishu:default:chat-stuck", async () => {
      order.push("follow-up:ran");
    });

    await followUp;

    expect(order).toEqual(["stuck:start", "follow-up:ran"]);
    expect(timeouts).toEqual([{ key: "feishu:default:chat-stuck", timeoutMs: 25 }]);

    // Drain the leaked stuck task so it doesn't trip the unhandled-rejection guard.
    stuckGate.resolve();
    await stuck;
  });

  it("disables the timeout cap when taskTimeoutMs is 0 (legacy behavior)", async () => {
    const timeouts: Array<{ key: string; timeoutMs: number }> = [];
    const enqueue = createSequentialQueue({
      taskTimeoutMs: 0,
      onTaskTimeout: (key, timeoutMs) => {
        timeouts.push({ key, timeoutMs });
      },
    });
    const gate = createDeferred();
    const order: string[] = [];

    const first = enqueue("feishu:default:chat-1", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = enqueue("feishu:default:chat-1", async () => {
      order.push("second:ran");
    });

    // Wait long enough that a timeout would have fired if it were active.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first:start"]);
    expect(timeouts).toEqual([]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:ran"]);
  });
});
