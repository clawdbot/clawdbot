// Session store writer tests cover serialized session writes and cleanup.
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import { clearSessionStoreCacheForTest } from "./store-writer-state.js";
import { runExclusiveSessionStoreWrite } from "./store-writer.js";

describe("session store writer", () => {
  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  it("serializes runtime writes through one in-process writer", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const order: string[] = [];

    const first = runExclusiveSessionStoreWrite(storePath, async () => {
      order.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first:end");
    });
    const second = runExclusiveSessionStoreWrite(storePath, async () => {
      order.push("second");
    });

    await firstStarted.promise;
    expect(order).toEqual(["first:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("runs nested writes for the active store without requeueing behind itself", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const order: string[] = [];

    const result = await runExclusiveSessionStoreWrite(storePath, async () => {
      order.push("outer:start");
      const nested = await runExclusiveSessionStoreWrite(
        storePath,
        async () => {
          order.push("inner");
          return "nested-result";
        },
        { reentrant: true },
      );
      order.push("outer:end");
      return nested;
    });

    expect(result).toBe("nested-result");
    expect(order).toEqual(["outer:start", "inner", "outer:end"]);
  });

  it("does not leak active writer state to async children after the writer returns", async () => {
    const storePath = "/tmp/openclaw-store.json";
    const order: string[] = [];
    let releaseChild = () => {};
    const childReleased = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let child: Promise<string> = Promise.resolve("not-started");

    await runExclusiveSessionStoreWrite(storePath, async () => {
      child = (async () => {
        await childReleased;
        return await runExclusiveSessionStoreWrite(storePath, async () => {
          order.push("child");
          return "child-result";
        });
      })();
    });

    let releaseBlocker = () => {};
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let markBlockerStarted = () => {};
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve;
    });
    const blocker = runExclusiveSessionStoreWrite(storePath, async () => {
      order.push("blocker:start");
      markBlockerStarted();
      await blockerReleased;
      order.push("blocker:end");
    });
    await blockerStarted;

    releaseChild();
    await Promise.resolve();
    expect(order).toEqual(["blocker:start"]);

    releaseBlocker();
    await Promise.all([blocker, child]);

    expect(order).toEqual(["blocker:start", "blocker:end", "child"]);
    expect(await child).toBe("child-result");
  });

  it("rejects empty store paths before enqueuing work", async () => {
    await expect(runExclusiveSessionStoreWrite("", async () => undefined)).rejects.toThrow(
      /storePath must be a non-empty string/,
    );
  });
});
