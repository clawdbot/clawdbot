// Verifies queue ownership and reentrancy across separately loaded runtime chunks.
import { AsyncLocalStorage } from "node:async_hooks";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "./store-writer-queue.js";

it("retains each queued writer's caller context through async and reentrant work", async () => {
  const contexts = new AsyncLocalStorage<string>();
  const queues = new Map<string, StoreWriterQueue>();
  const gate = createDeferred();
  const write = (owner: string, wait: Promise<void>) =>
    contexts.run(owner, () =>
      runQueuedStoreWrite({
        queues,
        storePath: "shared-store",
        label: owner,
        fn: async () => {
          await wait;
          return runQueuedStoreWrite({
            queues,
            storePath: "shared-store",
            label: "reentrant",
            reentrant: true,
            fn: async () => contexts.getStore(),
          });
        },
      }),
    );
  const first = write("first-owner", gate.promise);
  const second = write("second-owner", Promise.resolve());
  gate.resolve();
  expect(await Promise.all([first, second])).toEqual(["first-owner", "second-owner"]);
  expect(queues.size).toBe(0);
});

it("queues ordinary nested writes behind the active writer", async () => {
  const queues = new Map<string, StoreWriterQueue>();
  const order: string[] = [];
  let nested: Promise<unknown> | undefined;

  const outer = runQueuedStoreWrite({
    queues,
    storePath: "nested-store",
    label: "outer",
    fn: async () => {
      order.push("outer:start");
      nested = runQueuedStoreWrite({
        queues,
        storePath: "nested-store",
        label: "inner",
        fn: async () => {
          order.push("inner");
          return "inner-result";
        },
      });
      order.push("outer:end");
      return "outer-result";
    },
  });

  await expect(outer).resolves.toBe("outer-result");
  expect(order).toEqual(["outer:start", "outer:end", "inner"]);
  await expect(nested).resolves.toBe("inner-result");
  expect(queues.size).toBe(0);
});

it("shares reentrant writer context across duplicate module instances", async () => {
  const first = await importFreshModule<typeof import("./store-writer-queue.js")>(
    import.meta.url,
    "./store-writer-queue.js?scope=store-writer-a",
  );
  const second = await importFreshModule<typeof import("./store-writer-queue.js")>(
    import.meta.url,
    "./store-writer-queue.js?scope=store-writer-b",
  );
  const queues = new Map<string, StoreWriterQueue>();
  const order: string[] = [];

  const result = await first.runQueuedStoreWrite({
    queues,
    storePath: "shared-store",
    label: "outer",
    fn: async () => {
      order.push("outer:start");
      const nested = await second.runQueuedStoreWrite({
        queues,
        storePath: "shared-store",
        label: "inner",
        reentrant: true,
        fn: async () => {
          order.push("inner");
          return "nested-result";
        },
      });
      order.push("outer:end");
      return nested;
    },
  });

  expect(result).toBe("nested-result");
  expect(order).toEqual(["outer:start", "inner", "outer:end"]);
  expect(queues.size).toBe(0);
});
