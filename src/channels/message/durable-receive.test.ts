import { describe, expect, it } from "vitest";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "../../plugin-state/plugin-state-store.types.js";
import { createDurableInboundReceiveJournal } from "./durable-receive.js";

type TestPayload = { body: string };
type TestMetadata = { source: string };
type TestCompletedMetadata = { delivered: boolean };

function assertNoUndefinedFields(value: unknown): void {
  if (value === undefined) {
    throw new Error("undefined field");
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    assertNoUndefinedFields(entry);
  }
}

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, PluginStateEntry<T>>();
  return {
    async register(key, value) {
      assertNoUndefinedFields(value);
      values.set(key, { key, value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      assertNoUndefinedFields(value);
      values.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return Array.from(values.values());
    },
    async clear() {
      values.clear();
    },
  };
}

describe("createDurableInboundReceiveJournal", () => {
  it("accepts pending records once and reports duplicate pending deliveries", async () => {
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 10,
    });

    await expect(
      journal.accept("message-1", { body: "hello" }, { metadata: { source: "live" } }),
    ).resolves.toMatchObject({
      kind: "accepted",
      duplicate: false,
      record: {
        id: "message-1",
        payload: { body: "hello" },
        metadata: { source: "live" },
        receivedAt: 10,
      },
    });

    await expect(
      journal.accept("message-1", { body: "changed" }, { metadata: { source: "redeliver" } }),
    ).resolves.toMatchObject({
      kind: "pending",
      duplicate: true,
      record: {
        payload: { body: "hello" },
        metadata: { source: "live" },
      },
    });
  });

  it("keeps completed ids so later duplicates do not re-enter pending", async () => {
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 20,
    });

    await journal.accept("message-1", { body: "hello" });
    await journal.complete("message-1", { metadata: { delivered: true }, completedAt: 30 });

    await expect(journal.pending()).resolves.toEqual([]);
    await expect(journal.accept("message-1", { body: "again" })).resolves.toMatchObject({
      kind: "completed",
      duplicate: true,
      record: {
        id: "message-1",
        completedAt: 30,
        metadata: { delivered: true },
      },
    });
  });

  it("does not recreate pending state when completion wins a missing-pending race", async () => {
    let completedLookups = 0;
    const pendingStore: PluginStateKeyedStore<
      import("./durable-receive.js").DurableInboundReceivePendingRecord<TestPayload, TestMetadata>
    > = {
      async register() {
        throw new Error("pending register should not run");
      },
      async registerIfAbsent() {
        return false;
      },
      async lookup() {
        return undefined;
      },
      async consume() {
        return undefined;
      },
      async delete() {
        return false;
      },
      async entries() {
        return [];
      },
      async clear() {},
    };
    const completedStore: PluginStateKeyedStore<
      import("./durable-receive.js").DurableInboundReceiveCompletedRecord<TestCompletedMetadata>
    > = {
      async register() {},
      async registerIfAbsent() {
        return false;
      },
      async lookup() {
        completedLookups += 1;
        return completedLookups === 2
          ? { id: "message-1", completedAt: 40, metadata: { delivered: true } }
          : undefined;
      },
      async consume() {
        return undefined;
      },
      async delete() {
        return false;
      },
      async entries() {
        return [];
      },
      async clear() {},
    };
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore,
      completedStore,
    });

    await expect(journal.accept("message-1", { body: "again" })).resolves.toMatchObject({
      kind: "completed",
      duplicate: true,
      record: { completedAt: 40 },
    });
  });

  it("removes newly inserted pending state when completion wins the insert race", async () => {
    let completedLookups = 0;
    const pendingStore =
      createMemoryStore<
        import("./durable-receive.js").DurableInboundReceivePendingRecord<TestPayload, TestMetadata>
      >();
    const completedStore: PluginStateKeyedStore<
      import("./durable-receive.js").DurableInboundReceiveCompletedRecord<TestCompletedMetadata>
    > = {
      async register() {},
      async registerIfAbsent() {
        return false;
      },
      async lookup() {
        completedLookups += 1;
        return completedLookups === 2
          ? { id: "message-1", completedAt: 50, metadata: { delivered: true } }
          : undefined;
      },
      async consume() {
        return undefined;
      },
      async delete() {
        return false;
      },
      async entries() {
        return [];
      },
      async clear() {},
    };
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore,
      completedStore,
    });

    await expect(journal.accept("message-1", { body: "again" })).resolves.toMatchObject({
      kind: "completed",
      duplicate: true,
      record: { completedAt: 50 },
    });
    await expect(pendingStore.lookup("message-1")).resolves.toBeUndefined();
  });

  it("filters stale pending records when completion left both stores populated", async () => {
    const pendingStore =
      createMemoryStore<
        import("./durable-receive.js").DurableInboundReceivePendingRecord<TestPayload, TestMetadata>
      >();
    const completedStore =
      createMemoryStore<
        import("./durable-receive.js").DurableInboundReceiveCompletedRecord<TestCompletedMetadata>
      >();
    await pendingStore.register("message-1", {
      id: "message-1",
      payload: { body: "hello" },
      receivedAt: 1,
      updatedAt: 1,
      attempts: 0,
    });
    await completedStore.register("message-1", {
      id: "message-1",
      completedAt: 2,
      metadata: { delivered: true },
    });
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore,
      completedStore,
    });

    await expect(journal.pending()).resolves.toEqual([]);
    await expect(pendingStore.lookup("message-1")).resolves.toBeUndefined();
  });

  it("releases retryable records while preserving original receive order", async () => {
    let clock = 100;
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => clock,
    });

    await journal.accept("b", { body: "second" }, { receivedAt: 2 });
    await journal.accept("a", { body: "first" }, { receivedAt: 1 });

    clock = 200;
    await expect(journal.release("a", { lastError: "transient" })).resolves.toBe(true);

    await expect(journal.pending()).resolves.toMatchObject([
      {
        id: "a",
        attempts: 1,
        receivedAt: 1,
        lastAttemptAt: 200,
        lastError: "transient",
      },
      {
        id: "b",
        attempts: 0,
        receivedAt: 2,
      },
    ]);
  });
});
