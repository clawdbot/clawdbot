/**
 * Tests keyed async queue serialization and cancellation behavior.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../test-utils/deferred.js";
import { enqueueKeyedTask, KeyedAsyncQueue } from "./keyed-async-queue.js";

describe("enqueueKeyedTask", () => {
  it("serializes tasks per key and keeps different keys independent", async () => {
    const tails = new Map<string, Promise<void>>();
    const gate = createDeferred();
    const order: string[] = [];

    const first = enqueueKeyedTask({
      tails,
      key: "a",
      task: async () => {
        order.push("a1:start");
        await gate.promise;
        order.push("a1:end");
      },
    });
    const second = enqueueKeyedTask({
      tails,
      key: "a",
      task: async () => {
        order.push("a2:start");
        order.push("a2:end");
      },
    });
    const third = enqueueKeyedTask({
      tails,
      key: "b",
      task: async () => {
        order.push("b1:start");
        order.push("b1:end");
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain("a1:start");
    expect(order).toContain("b1:start");
    expect(order).not.toContain("a2:start");

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["a1:start", "b1:start", "b1:end", "a1:end", "a2:start", "a2:end"]);
    expect(tails.size).toBe(0);
  });

  it("keeps queue alive after task failures", async () => {
    const tails = new Map<string, Promise<void>>();
    const runs = [
      () =>
        enqueueKeyedTask({
          tails,
          key: "a",
          task: async () => {
            throw new Error("boom");
          },
        }),
      () =>
        enqueueKeyedTask({
          tails,
          key: "a",
          task: async () => "ok",
        }),
    ];

    await expect(expectDefined(runs[0], "runs[0] test invariant")()).rejects.toThrow("boom");
    await expect(expectDefined(runs[1], "runs[1] test invariant")()).resolves.toBe("ok");
  });

  it("does not leak unhandled rejections when a task failure is already awaited", async () => {
    const tails = new Map<string, Promise<void>>();
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(
        enqueueKeyedTask({
          tails,
          key: "a",
          task: async () => {
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow("boom");

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("runs enqueue/settle hooks once per task", async () => {
    const tails = new Map<string, Promise<void>>();
    const onEnqueue = vi.fn();
    const onSettle = vi.fn();
    await enqueueKeyedTask({
      tails,
      key: "a",
      task: async () => undefined,
      hooks: { onEnqueue, onSettle },
    });
    expect(onEnqueue).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});

describe("KeyedAsyncQueue", () => {
  it("serializes tasks while preserving their return values", async () => {
    const queue = new KeyedAsyncQueue();
    const gate = createDeferred();
    const order: string[] = [];
    const first = queue.enqueue("actor", async () => {
      order.push("first:start");
      await gate.promise;
      return 1;
    });
    const second = queue.enqueue("actor", async () => {
      order.push("second:start");
      return 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first:start", "second:start"]);
  });

  it("retains the deprecated tail-map accessor for Plugin SDK compatibility", () => {
    const queue = new KeyedAsyncQueue();
    expect(queue.getTailMapForTesting()).toBeInstanceOf(Map);
  });
});
