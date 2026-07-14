// Plugin state store tests cover per-plugin persisted state reads and writes.
import { rmSync, statSync } from "node:fs";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  clearPluginStateStoreForTests,
  closePluginStateDatabase,
  createCorePluginStateSyncKeyedStore,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.js";
import {
  probePluginStateStore,
  setMaxPluginStateEntriesPerPluginForTests,
} from "./plugin-state-store.sqlite.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

let testState: OpenClawTestState | undefined;

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-store" });
  rmSync(path.dirname(resolveOpenClawStateSqlitePath()), { recursive: true, force: true });
});

beforeEach(() => {
  testState?.applyEnv();
  clearPluginStateStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
  setMaxPluginStateEntriesPerPluginForTests(undefined);
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  await testState?.cleanup();
});

async function withPluginStateTestState<T>(fn: () => Promise<T>): Promise<T> {
  return await fn();
}

async function expectPluginStateStoreError(
  promise: Promise<unknown>,
  expected: { code: string; operation?: string },
): Promise<void> {
  let storeError: unknown;
  try {
    await promise;
  } catch (error) {
    storeError = error;
  }
  expect(storeError).toBeInstanceOf(PluginStateStoreError);
  expect((storeError as PluginStateStoreError | undefined)?.code).toBe(expected.code);
  if (expected.operation) {
    expect((storeError as PluginStateStoreError | undefined)?.operation).toBe(expected.operation);
  }
}

describe("plugin state keyed store", () => {
  it("registers and looks up values across store instances", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore<{ count: number }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      await store.register("interaction:1", { count: 1 });

      const reopened = createPluginStateKeyedStore<{ count: number }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      await expect(reopened.lookup("interaction:1")).resolves.toEqual({ count: 1 });
    });
  });

  it("supports synchronous keyed store callers", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateSyncKeyedStore<{ count: number }>("discord", {
        namespace: "sync-components",
        maxEntries: 10,
      });

      expect(store.registerIfAbsent("interaction:1", { count: 1 })).toBe(true);
      expect(store.registerIfAbsent("interaction:1", { count: 2 })).toBe(false);
      expect(store.lookup("interaction:1")).toEqual({ count: 1 });
      expect(store.entries()).toMatchObject([{ key: "interaction:1", value: { count: 1 } }]);
      expect(store.consume("interaction:1")).toEqual({ count: 1 });
      expect(store.lookup("interaction:1")).toBeUndefined();
    });
  });

  it("updates a key from the current stored value", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateSyncKeyedStore<{ count: number }>("discord", {
        namespace: "sync-update",
        maxEntries: 10,
      });
      const update = store.update;
      if (!update) {
        throw new Error("expected sync keyed store update support");
      }

      expect(update("counter", (current) => ({ count: (current?.count ?? 0) + 1 }))).toBe(true);
      expect(update("counter", (current) => ({ count: (current?.count ?? 0) + 1 }))).toBe(true);
      expect(update("counter", () => undefined)).toBe(false);
      expect(store.lookup("counter")).toEqual({ count: 2 });
    });
  });

  it("honors explicit store env without mutating process state", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-explicit-env-a", applyEnv: false },
      async (stateA) => {
        await withOpenClawTestState(
          { label: "plugin-state-explicit-env-b", applyEnv: false },
          async (stateB) => {
            const storeA = createPluginStateKeyedStore<{ owner: string }>("discord", {
              namespace: "explicit-env",
              maxEntries: 10,
              env: stateA.env,
            });
            const storeB = createPluginStateKeyedStore<{ owner: string }>("discord", {
              namespace: "explicit-env",
              maxEntries: 10,
              env: stateB.env,
            });

            await storeA.register("shared", { owner: "a" });
            await storeB.register("shared", { owner: "b" });

            await expect(storeA.lookup("shared")).resolves.toEqual({ owner: "a" });
            await expect(storeB.lookup("shared")).resolves.toEqual({ owner: "b" });
            expect(resolveOpenClawStateSqlitePath(stateA.env)).not.toBe(
              resolveOpenClawStateSqlitePath(stateB.env),
            );
          },
        );
      },
    );
  });

  it("upserts values and refreshes deterministic entry ordering", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<{ version: number }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });
      vi.setSystemTime(1000);
      await store.register("b", { version: 1 });
      vi.setSystemTime(2000);
      await store.register("a", { version: 1 });
      vi.setSystemTime(3000);
      await store.register("b", { version: 2 });

      await expect(store.lookup("b")).resolves.toEqual({ version: 2 });
      await expect(store.entries()).resolves.toEqual([
        { key: "a", value: { version: 1 }, createdAt: 2000 },
        { key: "b", value: { version: 2 }, createdAt: 3000 },
      ]);
    });
  });

  it("registerIfAbsent inserts the first value and preserves live duplicates", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<{ version: number }>("discord", {
        namespace: "claims",
        maxEntries: 10,
      });

      vi.setSystemTime(1000);
      await expect(store.registerIfAbsent("claim", { version: 1 }, { ttlMs: 1000 })).resolves.toBe(
        true,
      );
      vi.setSystemTime(1200);
      await expect(store.registerIfAbsent("claim", { version: 2 }, { ttlMs: 5000 })).resolves.toBe(
        false,
      );

      await expect(store.lookup("claim")).resolves.toEqual({ version: 1 });
      await expect(store.entries()).resolves.toEqual([
        { key: "claim", value: { version: 1 }, createdAt: 1000, expiresAt: 2000 },
      ]);
    });
  });

  it("registerIfAbsent replaces expired keys", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<{ version: number }>("discord", {
        namespace: "claims-expired",
        maxEntries: 10,
      });

      vi.setSystemTime(1000);
      await expect(store.registerIfAbsent("claim", { version: 1 }, { ttlMs: 100 })).resolves.toBe(
        true,
      );
      vi.setSystemTime(1200);
      await expect(store.registerIfAbsent("claim", { version: 2 })).resolves.toBe(true);

      await expect(store.lookup("claim")).resolves.toEqual({ version: 2 });
      await expect(store.entries()).resolves.toEqual([
        { key: "claim", value: { version: 2 }, createdAt: 1200 },
      ]);
    });
  });

  it("rejects new durable rows at capacity without evicting or blocking updates", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<number>("codex", {
        namespace: "durable-bindings",
        maxEntries: 2,
        overflowPolicy: "reject-new",
      });
      vi.setSystemTime(1000);
      await store.register("first", 1);
      vi.setSystemTime(2000);
      await store.register("second", 2);

      await expect(store.register("third", 3)).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });
      await expect(store.registerIfAbsent("first", 99)).resolves.toBe(false);
      if (!store.update) {
        throw new Error("plugin state update unavailable");
      }
      vi.setSystemTime(3000);
      await expect(store.update("first", () => 10)).resolves.toBe(true);
      await expect(store.update("third", () => 3)).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });
      await expect(store.entries()).resolves.toEqual([
        expect.objectContaining({ key: "second", value: 2 }),
        expect.objectContaining({ key: "first", value: 10 }),
      ]);
    });
  });

  it("registerIfAbsent keeps plugin and namespace claims isolated", async () => {
    await withPluginStateTestState(async () => {
      const discordA = createPluginStateKeyedStore<{ owner: string }>("discord", {
        namespace: "claims-a",
        maxEntries: 10,
      });
      const discordB = createPluginStateKeyedStore<{ owner: string }>("discord", {
        namespace: "claims-b",
        maxEntries: 10,
      });
      const telegramA = createPluginStateKeyedStore<{ owner: string }>("telegram", {
        namespace: "claims-a",
        maxEntries: 10,
      });

      await expect(discordA.registerIfAbsent("same", { owner: "discord-a" })).resolves.toBe(true);
      await expect(discordB.registerIfAbsent("same", { owner: "discord-b" })).resolves.toBe(true);
      await expect(telegramA.registerIfAbsent("same", { owner: "telegram-a" })).resolves.toBe(true);
      await expect(discordA.registerIfAbsent("same", { owner: "overwrite" })).resolves.toBe(false);

      await expect(discordA.lookup("same")).resolves.toEqual({ owner: "discord-a" });
      await expect(discordB.lookup("same")).resolves.toEqual({ owner: "discord-b" });
      await expect(telegramA.lookup("same")).resolves.toEqual({ owner: "telegram-a" });
    });
  });

  it("registerIfAbsent only lets one parallel claimant win", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore<{ claimant: number }>("discord", {
        namespace: "claims-race",
        maxEntries: 10,
      });

      const attempts = await Promise.all(
        Array.from({ length: 25 }, async (_, claimant) =>
          store.registerIfAbsent("claim", { claimant }),
        ),
      );

      expect(attempts.reduce((count, attempt) => count + (attempt ? 1 : 0), 0)).toBe(1);
      const stored = await store.lookup("claim");
      if (stored === undefined) {
        throw new Error("expected winning plugin-state claim");
      }
      expect(attempts[stored.claimant]).toBe(true);
    });
  });

  it("registerIfAbsent preserves eviction and plugin row cap behavior", async () => {
    await withPluginStateTestState(async () => {
      const maxPluginEntries = 40;
      setMaxPluginStateEntriesPerPluginForTests(maxPluginEntries);
      vi.useFakeTimers();
      const evicting = createPluginStateKeyedStore<number>("discord", {
        namespace: "claims-evict",
        maxEntries: 2,
      });
      vi.setSystemTime(1000);
      await evicting.registerIfAbsent("a", 1);
      vi.setSystemTime(2000);
      await evicting.registerIfAbsent("b", 2);
      vi.setSystemTime(3000);
      await evicting.registerIfAbsent("c", 3);
      expect((await evicting.entries()).map((entry) => entry.key)).toEqual(["b", "c"]);

      seedPluginStateEntriesForTests([
        ...Array.from({ length: maxPluginEntries - 1 }, (_, entryIndex) => ({
          pluginId: "limited-plugin",
          namespace: "limit",
          key: `k-${entryIndex}`,
          value: { entryIndex },
        })),
        {
          pluginId: "limited-plugin",
          namespace: "sibling",
          key: "k-0",
          value: { sibling: true },
        },
      ]);
      const limited = createPluginStateKeyedStore("limited-plugin", {
        namespace: "limit",
        maxEntries: maxPluginEntries + 1,
      });
      const sibling = createPluginStateKeyedStore("limited-plugin", {
        namespace: "sibling",
        maxEntries: 10,
      });
      await expect(limited.registerIfAbsent("overflow", { overflow: true })).resolves.toBe(true);
      await expect(limited.lookup("k-0")).resolves.toBeUndefined();
      await expect(limited.lookup("overflow")).resolves.toEqual({ overflow: true });
      await expect(sibling.lookup("k-0")).resolves.toEqual({ sibling: true });
    });
  });

  it("returns undefined for missing lookups and consumes by deleting atomically", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore<{ ok: boolean }>("discord", {
        namespace: "components",
        maxEntries: 10,
      });

      await expect(store.lookup("missing")).resolves.toBeUndefined();
      await expect(store.consume("missing")).resolves.toBeUndefined();
      await store.register("k", { ok: true });
      await expect(store.consume("k")).resolves.toEqual({ ok: true });
      await expect(store.lookup("k")).resolves.toBeUndefined();
    });
  });

  it("deletes and clears only the targeted namespace", async () => {
    await withPluginStateTestState(async () => {
      const first = createPluginStateKeyedStore("discord", { namespace: "a", maxEntries: 10 });
      const second = createPluginStateKeyedStore("discord", { namespace: "b", maxEntries: 10 });
      await first.register("k1", { value: 1 });
      await second.register("k2", { value: 2 });

      await expect(first.delete("k1")).resolves.toBe(true);
      await expect(first.delete("k1")).resolves.toBe(false);
      await first.register("k1", { value: 1 });
      await first.clear();

      await expect(first.entries()).resolves.toStrictEqual([]);
      await expect(second.lookup("k2")).resolves.toEqual({ value: 2 });
    });
  });

  it("excludes expired entries and sweeps them", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const store = createPluginStateKeyedStore("discord", {
        namespace: "ttl",
        maxEntries: 10,
        defaultTtlMs: 100,
      });
      await store.register("default", { value: "default" });
      await store.register("override", { value: "override" }, { ttlMs: 500 });

      vi.setSystemTime(1200);
      await expect(store.lookup("default")).resolves.toBeUndefined();
      await expect(store.lookup("override")).resolves.toEqual({ value: "override" });
      expect(sweepExpiredPluginStateEntries()).toBe(1);
      expect((await store.entries()).map((entry) => entry.key)).toEqual(["override"]);
    });
  });

  it("rejects plugin state ttl when expiry cannot fit in a Date timestamp", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore("discord", {
        namespace: "ttl-bounds",
        maxEntries: 10,
      });

      await expectPluginStateStoreError(store.register("huge", true, { ttlMs: Number.MAX_VALUE }), {
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "register",
      });

      const nowSpy = vi.spyOn(Date, "now");
      try {
        nowSpy.mockReturnValue(MAX_DATE_TIMESTAMP_MS);
        await expectPluginStateStoreError(store.register("overflow", true, { ttlMs: 60_000 }), {
          code: "PLUGIN_STATE_INVALID_INPUT",
          operation: "register",
        });
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  it("evicts oldest live entries over maxEntries", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore("discord", { namespace: "evict", maxEntries: 2 });
      vi.setSystemTime(1000);
      await store.register("a", 1);
      vi.setSystemTime(2000);
      await store.register("b", 2);
      vi.setSystemTime(3000);
      await store.register("c", 3);

      expect((await store.entries()).map((entry) => entry.key)).toEqual(["b", "c"]);
    });
  });

  it("keeps the just-registered key when namespace eviction timestamps tie", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const store = createPluginStateKeyedStore<number>("discord", {
        namespace: "evict-tie-register",
        maxEntries: 1,
      });

      await store.register("z", 1);
      await store.register("a", 2);

      await expect(store.entries()).resolves.toEqual([{ key: "a", value: 2, createdAt: 1000 }]);
      await expect(store.lookup("z")).resolves.toBeUndefined();
    });
  });

  it("keeps a same-millisecond registerIfAbsent claim during namespace eviction", async () => {
    await withPluginStateTestState(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const store = createPluginStateKeyedStore<number>("discord", {
        namespace: "evict-tie-claim",
        maxEntries: 1,
      });

      await expect(store.registerIfAbsent("z", 1)).resolves.toBe(true);
      await expect(store.registerIfAbsent("a", 2)).resolves.toBe(true);

      await expect(store.entries()).resolves.toEqual([{ key: "a", value: 2, createdAt: 1000 }]);
      await expect(store.lookup("z")).resolves.toBeUndefined();
    });
  });

  it("evicts current namespace rows when sibling namespaces consume plugin row budget", async () => {
    await withPluginStateTestState(async () => {
      const maxPluginEntries = 40;
      setMaxPluginStateEntriesPerPluginForTests(maxPluginEntries);
      seedPluginStateEntriesForTests([
        ...Array.from({ length: maxPluginEntries - 11 }, (_, entryIndex) => ({
          pluginId: "telegram",
          namespace: "telegram.message-cache",
          key: `k-${entryIndex}`,
          value: { kind: "message", entryIndex },
        })),
        ...Array.from({ length: 11 }, (_, entryIndex) => ({
          pluginId: "telegram",
          namespace: "telegram.topic-name-cache",
          key: `topic-${entryIndex}`,
          value: { kind: "topic", entryIndex },
        })),
      ]);

      const messageStore = createPluginStateKeyedStore("telegram", {
        namespace: "telegram.message-cache",
        maxEntries: maxPluginEntries,
      });
      const topicStore = createPluginStateKeyedStore("telegram", {
        namespace: "telegram.topic-name-cache",
        maxEntries: 100,
      });

      await expect(
        messageStore.register("new-message", { kind: "message", fresh: true }),
      ).resolves.toBeUndefined();

      await expect(messageStore.lookup("k-0")).resolves.toBeUndefined();
      await expect(messageStore.lookup("new-message")).resolves.toEqual({
        kind: "message",
        fresh: true,
      });
      await expect(topicStore.lookup("topic-0")).resolves.toEqual({
        kind: "topic",
        entryIndex: 0,
      });
      await expect(messageStore.entries()).resolves.toHaveLength(maxPluginEntries - 11);
      await expect(topicStore.entries()).resolves.toHaveLength(11);
    });
  });

  it("leaves room for Telegram sibling namespaces at their persistent budgets", async () => {
    await withPluginStateTestState(async () => {
      seedPluginStateEntriesForTests([
        ...Array.from({ length: 3_000 }, (_, entryIndex) => ({
          pluginId: "telegram",
          namespace: "telegram.message-cache",
          key: `message-${entryIndex}`,
          value: { kind: "message", entryIndex },
        })),
        ...Array.from({ length: 2_047 }, (_, entryIndex) => ({
          pluginId: "telegram",
          namespace: "telegram.topic-name-cache",
          key: `topic-${entryIndex}`,
          value: { kind: "topic", updatedAt: entryIndex },
        })),
        ...Array.from({ length: 127 }, (_, entryIndex) => ({
          pluginId: "telegram",
          namespace: "telegram.bot-info-cache",
          key: `bot-${entryIndex}`,
          value: { kind: "bot-info", fetchedAt: String(entryIndex) },
        })),
      ]);

      const topicStore = createPluginStateKeyedStore("telegram", {
        namespace: "telegram.topic-name-cache",
        maxEntries: 2_048,
      });
      const botInfoStore = createPluginStateKeyedStore("telegram", {
        namespace: "telegram.bot-info-cache",
        maxEntries: 128,
      });

      await expect(
        topicStore.register("topic-final", { kind: "topic", updatedAt: 2_048 }),
      ).resolves.toBeUndefined();
      await expect(
        botInfoStore.register("default", { kind: "bot-info", fetchedAt: "now" }),
      ).resolves.toBeUndefined();

      await expect(topicStore.lookup("topic-final")).resolves.toEqual({
        kind: "topic",
        updatedAt: 2_048,
      });
      await expect(botInfoStore.lookup("default")).resolves.toEqual({
        kind: "bot-info",
        fetchedAt: "now",
      });
    });
  });

  it("rejects plugin overflow when the current namespace cannot shed old rows", async () => {
    await withPluginStateTestState(async () => {
      const maxPluginEntries = 40;
      setMaxPluginStateEntriesPerPluginForTests(maxPluginEntries);
      seedPluginStateEntriesForTests(
        Array.from({ length: maxPluginEntries }, (_, entryIndex) => ({
          pluginId: "telegram",
          namespace: "telegram.topic-name-cache",
          key: `topic-${entryIndex}`,
          value: { entryIndex },
        })),
      );

      const messageStore = createPluginStateKeyedStore("telegram", {
        namespace: "telegram.message-cache",
        maxEntries: maxPluginEntries,
      });
      const topicStore = createPluginStateKeyedStore("telegram", {
        namespace: "telegram.topic-name-cache",
        maxEntries: maxPluginEntries,
      });

      await expectPluginStateStoreError(messageStore.register("new-message", { fresh: true }), {
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });
      await expect(messageStore.lookup("new-message")).resolves.toBeUndefined();
      await expect(topicStore.lookup("topic-0")).resolves.toEqual({ entryIndex: 0 });
    });
  });

  it("segregates plugins sharing a namespace and key", async () => {
    await withPluginStateTestState(async () => {
      const discord = createPluginStateKeyedStore("discord", { namespace: "same", maxEntries: 10 });
      const telegram = createPluginStateKeyedStore("telegram", {
        namespace: "same",
        maxEntries: 10,
      });
      await discord.register("k", { plugin: "discord" });
      await telegram.register("k", { plugin: "telegram" });
      await discord.clear();

      await expect(discord.lookup("k")).resolves.toBeUndefined();
      await expect(telegram.lookup("k")).resolves.toEqual({ plugin: "telegram" });
    });
  });

  it("validates namespaces, keys, options, and JSON values before writes", async () => {
    await withPluginStateTestState(async () => {
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "../bad", maxEntries: 10 }),
      ).toThrow(PluginStateStoreError);
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "bad-max", maxEntries: 0 }),
      ).toThrow(PluginStateStoreError);

      const store = createPluginStateKeyedStore("discord", { namespace: "valid", maxEntries: 10 });
      await expect(store.register(" ", { ok: true })).rejects.toThrow(PluginStateStoreError);
      await expect(store.register("undefined", undefined)).rejects.toThrow(PluginStateStoreError);
      await expect(store.register("infinity", Number.POSITIVE_INFINITY)).rejects.toThrow(
        PluginStateStoreError,
      );
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(store.register("circular", circular)).rejects.toThrow(PluginStateStoreError);
      const sparse = [] as unknown[];
      sparse[1] = "hole";
      await expect(store.register("sparse", sparse)).rejects.toThrow(PluginStateStoreError);
      await expect(store.register("date", new Date())).rejects.toThrow(PluginStateStoreError);
      await expect(store.register("map", new Map([["k", "v"]]))).rejects.toThrow(
        PluginStateStoreError,
      );
      const nonEnumerable = { visible: true };
      Object.defineProperty(nonEnumerable, "hidden", { value: true, enumerable: false });
      await expect(store.register("non-enumerable", nonEnumerable)).rejects.toThrow(
        PluginStateStoreError,
      );
      await expectPluginStateStoreError(store.register("big", "x".repeat(65_537)), {
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });

      // Key byte-length limit (512 bytes)
      await expect(store.register("k".repeat(513), { ok: true })).rejects.toThrow(
        PluginStateStoreError,
      );

      // Namespace byte-length limit (128 bytes)
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "a".repeat(129), maxEntries: 10 }),
      ).toThrow(PluginStateStoreError);

      // JSON depth limit (64 levels)
      let deep: unknown = { leaf: true };
      for (let i = 0; i < 65; i += 1) {
        deep = { nested: deep };
      }
      await expectPluginStateStoreError(store.register("deep", deep), {
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });

      // Validation errors surface the correct operation
      await expectPluginStateStoreError(store.lookup(" "), {
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "lookup",
      });
      await expectPluginStateStoreError(store.delete(" "), {
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "delete",
      });
    });
  });

  it("rejects reopening the same namespace with incompatible options", async () => {
    await withPluginStateTestState(async () => {
      createPluginStateKeyedStore("discord", { namespace: "same", maxEntries: 10 });
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "same", maxEntries: 11 }),
      ).toThrow(PluginStateStoreError);
    });
  });

  it("allows core owners and reserves core-prefixed plugin ids", async () => {
    await withPluginStateTestState(async () => {
      const store = createCorePluginStateSyncKeyedStore<{ stopped: boolean }>({
        ownerId: "core:channel-intent",
        namespace: "stopped",
        maxEntries: 10,
      });
      store.register("telegram:personal", { stopped: true });
      expect(store.lookup("telegram:personal")).toEqual({ stopped: true });
      expect(() =>
        createPluginStateKeyedStore("core:not-a-plugin", { namespace: "bad", maxEntries: 10 }),
      ).toThrow(PluginStateStoreError);
    });
  });

  it("closes the cached DB handle and reopens cleanly", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore("discord", { namespace: "close", maxEntries: 10 });
      await store.register("k", { ok: true });
      const database = openOpenClawStateDatabase();
      closePluginStateDatabase();
      expect(() => database.db.exec("SELECT 1")).toThrow();
      await expect(store.lookup("k")).resolves.toEqual({ ok: true });
    });
  });

  it("does not close a shared state database opened before the plugin-state probe", async () => {
    await withPluginStateTestState(async () => {
      const database = openOpenClawStateDatabase();
      const result = probePluginStateStore();

      expect(result.ok).toBe(true);
      expect(database.db.isOpen).toBe(true);
    });
  });

  it("reopens after the shared state DB cache closes its handle", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore("discord", {
        namespace: "cache-switch",
        maxEntries: 10,
      });
      await store.register("k", { ok: true });

      const secondary = await createOpenClawTestState({
        label: "plugin-state-cache-secondary",
        applyEnv: false,
      });
      try {
        openOpenClawStateDatabase({ env: secondary.env });
        testState?.applyEnv();
        await expect(store.lookup("k")).resolves.toEqual({ ok: true });
      } finally {
        await secondary.cleanup();
      }
    });
  });

  it.runIf(process.platform !== "win32")("hardens DB directory and file permissions", async () => {
    await withPluginStateTestState(async () => {
      const store = createPluginStateKeyedStore("discord", { namespace: "perms", maxEntries: 10 });
      await store.register("k", { ok: true });

      const databasePath = resolveOpenClawStateSqlitePath();
      expect(statSync(path.dirname(databasePath)).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    });
  });

  it("reports healthy diagnostics without stored values", async () => {
    await withPluginStateTestState(async () => {
      const result = probePluginStateStore();
      expect(result.ok).toBe(true);
      const failedSteps = result.steps.filter((step) => !step.ok);
      expect(failedSteps).toStrictEqual([]);
      expect(JSON.stringify(result)).not.toContain("probe-value");
    });
  });

  it("reports an unhealthy probe when the clock cannot produce a valid ttl expiry", async () => {
    await withPluginStateTestState(async () => {
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(MAX_DATE_TIMESTAMP_MS);

      try {
        const result = probePluginStateStore();

        expect(result.ok).toBe(false);
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: "probe",
            ok: false,
            code: "PLUGIN_STATE_INVALID_INPUT",
          }),
        );
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
