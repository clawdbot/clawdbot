import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionStoreCacheForTest,
  getSessionStoreWriterQueueSizeForTest,
  withSessionStoreWriterForTest,
} from "./store.js";

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

describe("session store writer", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  it("serializes runtime writes through one in-process writer", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const order: string[] = [];

    const first = withSessionStoreWriterForTest(storePath, async () => {
      order.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first:end");
    });
    const second = withSessionStoreWriterForTest(storePath, async () => {
      order.push("second");
    });

    await firstStarted.promise;
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(1);
    expect(order).toEqual(["first:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(0);
  });

  it("rejects empty store paths before enqueuing work", async () => {
    await expect(withSessionStoreWriterForTest("", async () => undefined)).rejects.toThrow(
      /storePath must be a non-empty string/,
    );
    expect(getSessionStoreWriterQueueSizeForTest()).toBe(0);
  });
});
