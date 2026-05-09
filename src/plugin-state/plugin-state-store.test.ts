import { mkdirSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateSqliteStore,
  createCorePluginStateKeyedStore,
  createPluginStateKeyedStore,
  PluginStateStoreError,
  probePluginStateStore,
  resetPluginStateStoreForTests,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.js";
import { resolvePluginStateDir, resolvePluginStateSqlitePath } from "./plugin-state-store.paths.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

describe("plugin state keyed store", () => {
  it("registers and looks up values across store instances", async () => {
    await withOpenClawTestState({ label: "plugin-state-roundtrip" }, async () => {
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

  it("upserts values and refreshes deterministic entry ordering", async () => {
    await withOpenClawTestState({ label: "plugin-state-upsert" }, async () => {
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
      await expect(store.entries()).resolves.toMatchObject([
        { key: "a", value: { version: 1 }, createdAt: 2000 },
        { key: "b", value: { version: 2 }, createdAt: 3000 },
      ]);
    });
  });

  it("registerIfAbsent inserts the first value and preserves live duplicates", async () => {
    await withOpenClawTestState({ label: "plugin-state-register-if-absent-live" }, async () => {
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
      await expect(store.entries()).resolves.toMatchObject([
        { key: "claim", value: { version: 1 }, createdAt: 1000, expiresAt: 2000 },
      ]);
    });
  });

  it("registerIfAbsent replaces expired keys", async () => {
    await withOpenClawTestState({ label: "plugin-state-register-if-absent-expired" }, async () => {
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
      await expect(store.entries()).resolves.toMatchObject([
        { key: "claim", value: { version: 2 }, createdAt: 1200 },
      ]);
    });
  });

  it("registerIfAbsent keeps plugin and namespace claims isolated", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-register-if-absent-isolation" },
      async () => {
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
        await expect(telegramA.registerIfAbsent("same", { owner: "telegram-a" })).resolves.toBe(
          true,
        );
        await expect(discordA.registerIfAbsent("same", { owner: "overwrite" })).resolves.toBe(
          false,
        );

        await expect(discordA.lookup("same")).resolves.toEqual({ owner: "discord-a" });
        await expect(discordB.lookup("same")).resolves.toEqual({ owner: "discord-b" });
        await expect(telegramA.lookup("same")).resolves.toEqual({ owner: "telegram-a" });
      },
    );
  });

  it("registerIfAbsent only lets one parallel claimant win", async () => {
    await withOpenClawTestState({ label: "plugin-state-register-if-absent-race" }, async () => {
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
    await withOpenClawTestState({ label: "plugin-state-register-if-absent-limits" }, async () => {
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
      await expect(evicting.entries()).resolves.toMatchObject([{ key: "b" }, { key: "c" }]);

      seedPluginStateEntriesForTests([
        ...Array.from({ length: 999 }, (_, entryIndex) => ({
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
        maxEntries: 1_001,
      });
      await expect(limited.registerIfAbsent("overflow", { overflow: true })).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });
      await expect(limited.lookup("overflow")).resolves.toBeUndefined();
    });
  });

  it("returns undefined for missing lookups and consumes by deleting atomically", async () => {
    await withOpenClawTestState({ label: "plugin-state-consume" }, async () => {
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
    await withOpenClawTestState({ label: "plugin-state-clear" }, async () => {
      const first = createPluginStateKeyedStore("discord", { namespace: "a", maxEntries: 10 });
      const second = createPluginStateKeyedStore("discord", { namespace: "b", maxEntries: 10 });
      await first.register("k1", { value: 1 });
      await second.register("k2", { value: 2 });

      await expect(first.delete("k1")).resolves.toBe(true);
      await expect(first.delete("k1")).resolves.toBe(false);
      await first.register("k1", { value: 1 });
      await first.clear();

      await expect(first.entries()).resolves.toEqual([]);
      await expect(second.lookup("k2")).resolves.toEqual({ value: 2 });
    });
  });

  it("excludes expired entries and sweeps them", async () => {
    await withOpenClawTestState({ label: "plugin-state-expiry" }, async () => {
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
      await expect(store.entries()).resolves.toMatchObject([{ key: "override" }]);
    });
  });

  it("evicts oldest live entries over maxEntries", async () => {
    await withOpenClawTestState({ label: "plugin-state-eviction" }, async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore("discord", { namespace: "evict", maxEntries: 2 });
      vi.setSystemTime(1000);
      await store.register("a", 1);
      vi.setSystemTime(2000);
      await store.register("b", 2);
      vi.setSystemTime(3000);
      await store.register("c", 3);

      await expect(store.entries()).resolves.toMatchObject([{ key: "b" }, { key: "c" }]);
    });
  });

  it("keeps the just-registered key when namespace eviction timestamps tie", async () => {
    await withOpenClawTestState({ label: "plugin-state-eviction-tie-register" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const store = createPluginStateKeyedStore<number>("discord", {
        namespace: "evict-tie-register",
        maxEntries: 1,
      });

      await store.register("z", 1);
      await store.register("a", 2);

      await expect(store.entries()).resolves.toMatchObject([{ key: "a", value: 2 }]);
      await expect(store.lookup("z")).resolves.toBeUndefined();
    });
  });

  it("keeps a same-millisecond registerIfAbsent claim during namespace eviction", async () => {
    await withOpenClawTestState({ label: "plugin-state-eviction-tie-claim" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const store = createPluginStateKeyedStore<number>("discord", {
        namespace: "evict-tie-claim",
        maxEntries: 1,
      });

      await expect(store.registerIfAbsent("z", 1)).resolves.toBe(true);
      await expect(store.registerIfAbsent("a", 2)).resolves.toBe(true);

      await expect(store.entries()).resolves.toMatchObject([{ key: "a", value: 2 }]);
      await expect(store.lookup("z")).resolves.toBeUndefined();
    });
  });

  it("rejects when the per-plugin live row ceiling would be exceeded without evicting siblings", async () => {
    await withOpenClawTestState({ label: "plugin-state-plugin-limit" }, async () => {
      seedPluginStateEntriesForTests([
        ...Array.from({ length: 999 }, (_, entryIndex) => ({
          pluginId: "discord",
          namespace: "limit",
          key: `k-${entryIndex}`,
          value: { namespaceIndex: 0, entryIndex },
        })),
        {
          pluginId: "discord",
          namespace: "sibling",
          key: "k-0",
          value: { namespaceIndex: 1, entryIndex: 0 },
        },
      ]);

      const limitStore = createPluginStateKeyedStore("discord", {
        namespace: "limit",
        maxEntries: 1_001,
      });
      const siblingStore = createPluginStateKeyedStore("discord", {
        namespace: "sibling",
        maxEntries: 10,
      });

      await expect(limitStore.register("overflow", { overflow: true })).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });
      await expect(siblingStore.lookup("k-0")).resolves.toEqual({
        namespaceIndex: 1,
        entryIndex: 0,
      });
      await expect(limitStore.lookup("overflow")).resolves.toBeUndefined();
    });
  });

  it("segregates plugins sharing a namespace and key", async () => {
    await withOpenClawTestState({ label: "plugin-state-segregation" }, async () => {
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
    await withOpenClawTestState({ label: "plugin-state-validation" }, async () => {
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
      await expect(store.register("big", "x".repeat(65_537))).rejects.toMatchObject({
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
      await expect(store.register("deep", deep)).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });

      // Validation errors surface the correct operation
      await expect(store.lookup(" ")).rejects.toMatchObject({
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "lookup",
      });
      await expect(store.delete(" ")).rejects.toMatchObject({
        code: "PLUGIN_STATE_INVALID_INPUT",
        operation: "delete",
      });
    });
  });

  it("rejects reopening the same namespace with incompatible options", async () => {
    await withOpenClawTestState({ label: "plugin-state-option-consistency" }, async () => {
      createPluginStateKeyedStore("discord", { namespace: "same", maxEntries: 10 });
      expect(() =>
        createPluginStateKeyedStore("discord", { namespace: "same", maxEntries: 11 }),
      ).toThrow(PluginStateStoreError);
    });
  });

  it("allows core owners and reserves core-prefixed plugin ids", async () => {
    await withOpenClawTestState({ label: "plugin-state-core" }, async () => {
      const store = createCorePluginStateKeyedStore<{ stopped: boolean }>({
        ownerId: "core:channel-intent",
        namespace: "stopped",
        maxEntries: 10,
      });
      await store.register("telegram:personal", { stopped: true });
      await expect(store.lookup("telegram:personal")).resolves.toEqual({ stopped: true });
      expect(() =>
        createPluginStateKeyedStore("core:not-a-plugin", { namespace: "bad", maxEntries: 10 }),
      ).toThrow(PluginStateStoreError);
    });
  });

  it("closes the cached DB handle and reopens cleanly", async () => {
    await withOpenClawTestState({ label: "plugin-state-close" }, async () => {
      const store = createPluginStateKeyedStore("discord", { namespace: "close", maxEntries: 10 });
      await store.register("k", { ok: true });
      closePluginStateSqliteStore();
      await expect(store.lookup("k")).resolves.toEqual({ ok: true });
    });
  });

  it.runIf(process.platform !== "win32")("hardens DB directory and file permissions", async () => {
    await withOpenClawTestState({ label: "plugin-state-permissions" }, async () => {
      const store = createPluginStateKeyedStore("discord", { namespace: "perms", maxEntries: 10 });
      await store.register("k", { ok: true });

      expect(statSync(resolvePluginStateDir()).mode & 0o777).toBe(0o700);
      expect(statSync(resolvePluginStateSqlitePath()).mode & 0o777).toBe(0o600);
    });
  });

  it("reports healthy diagnostics without stored values", async () => {
    await withOpenClawTestState({ label: "plugin-state-probe" }, async () => {
      const result = probePluginStateStore();
      expect(result.ok).toBe(true);
      const failedSteps = result.steps.filter((step) => !step.ok);
      expect(failedSteps).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("probe-value");
    });
  });

  it("throws on unsupported future schema versions", async () => {
    await withOpenClawTestState({ label: "plugin-state-schema" }, async () => {
      mkdirSync(resolvePluginStateDir(), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(resolvePluginStateSqlitePath());
      db.exec("PRAGMA user_version = 2;");
      db.close();

      const store = createPluginStateKeyedStore("discord", { namespace: "schema", maxEntries: 10 });
      await expect(store.register("k", { ok: true })).rejects.toMatchObject({
        code: "PLUGIN_STATE_SCHEMA_UNSUPPORTED",
      });
    });
  });
});
