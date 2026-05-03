import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateSqliteStore,
  createPluginStateKeyedStore,
  PluginStateStoreError,
  probePluginStateStore,
  resetPluginStateStoreForTests,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.js";
import { resolvePluginStateDir, resolvePluginStateSqlitePath } from "./plugin-state-store.paths.js";
import { MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN } from "./plugin-state-store.sqlite.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

// ---------------------------------------------------------------------------
// Runtime smoke
// ---------------------------------------------------------------------------
describe("runtime smoke", () => {
  it("creates and exercises a keyed store directly", async () => {
    await withOpenClawTestState({ label: "e2e-smoke-load" }, async () => {
      const store = createPluginStateKeyedStore<{ ready: boolean }>("fixture-plugin", {
        namespace: "boot",
        maxEntries: 10,
      });
      expect(store).toBeDefined();
      expect(typeof store.register).toBe("function");
      expect(typeof store.lookup).toBe("function");
      expect(typeof store.consume).toBe("function");
    });
  });

  it("writes and reads a value", async () => {
    await withOpenClawTestState({ label: "e2e-smoke-rw" }, async () => {
      const store = createPluginStateKeyedStore<{ msg: string }>("fixture-plugin", {
        namespace: "data",
        maxEntries: 10,
      });
      await store.register("greeting", { msg: "hello" });
      await expect(store.lookup("greeting")).resolves.toEqual({ msg: "hello" });
    });
  });

  it("consumes a value exactly once", async () => {
    await withOpenClawTestState({ label: "e2e-smoke-consume" }, async () => {
      const store = createPluginStateKeyedStore<{ token: string }>("fixture-plugin", {
        namespace: "tokens",
        maxEntries: 10,
      });
      await store.register("one-shot", { token: "abc123" });

      const first = await store.consume("one-shot");
      expect(first).toEqual({ token: "abc123" });

      const second = await store.consume("one-shot");
      expect(second).toBeUndefined();

      await expect(store.lookup("one-shot")).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
describe("persistence", () => {
  it("survives close and reopen of the store", async () => {
    await withOpenClawTestState({ label: "e2e-persist" }, async () => {
      const storeA = createPluginStateKeyedStore<{ persisted: boolean }>("fixture-plugin", {
        namespace: "durable",
        maxEntries: 10,
      });
      await storeA.register("key1", { persisted: true });
      await storeA.register("key2", { persisted: true });

      // Tear down the cached DB handle and option signatures – simulates
      // a full gateway restart while the on-disk DB survives.
      resetPluginStateStoreForTests();

      const storeB = createPluginStateKeyedStore<{ persisted: boolean }>("fixture-plugin", {
        namespace: "durable",
        maxEntries: 10,
      });
      await expect(storeB.lookup("key1")).resolves.toEqual({ persisted: true });
      await expect(storeB.lookup("key2")).resolves.toEqual({ persisted: true });
    });
  });
});

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------
describe("TTL", () => {
  it("hides expired values and sweep removes the row", async () => {
    await withOpenClawTestState({ label: "e2e-ttl" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);

      const store = createPluginStateKeyedStore<{ v: number }>("fixture-plugin", {
        namespace: "ttl-test",
        maxEntries: 10,
      });
      await store.register("short", { v: 1 }, { ttlMs: 500 });
      await store.register("long", { v: 2 }, { ttlMs: 60_000 });

      // Before expiry – both visible.
      await expect(store.lookup("short")).resolves.toEqual({ v: 1 });
      await expect(store.lookup("long")).resolves.toEqual({ v: 2 });

      // Advance past the short TTL.
      vi.setSystemTime(10_600);

      // Expired value is invisible to reads.
      await expect(store.lookup("short")).resolves.toBeUndefined();
      await expect(store.lookup("long")).resolves.toEqual({ v: 2 });

      // Sweep physically removes the expired row.
      const swept = sweepExpiredPluginStateEntries();
      expect(swept).toBe(1);

      // After sweep the entry list contains only the long-lived record.
      const remaining = await store.entries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].key).toBe("long");
    });
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------
describe("isolation", () => {
  it("segregates plugins sharing namespace and key", async () => {
    await withOpenClawTestState({ label: "e2e-isolation" }, async () => {
      const pluginA = createPluginStateKeyedStore<{ owner: string }>("plugin-a", {
        namespace: "x",
        maxEntries: 10,
      });
      const pluginB = createPluginStateKeyedStore<{ owner: string }>("plugin-b", {
        namespace: "x",
        maxEntries: 10,
      });

      await pluginA.register("same", { owner: "a" });
      await pluginB.register("same", { owner: "b" });

      await expect(pluginA.lookup("same")).resolves.toEqual({ owner: "a" });
      await expect(pluginB.lookup("same")).resolves.toEqual({ owner: "b" });

      // Clearing one plugin's namespace does not affect the other.
      await pluginA.clear();
      await expect(pluginA.lookup("same")).resolves.toBeUndefined();
      await expect(pluginB.lookup("same")).resolves.toEqual({ owner: "b" });
    });
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
describe("limits", () => {
  it("accepts a value at the 64 KB boundary", async () => {
    await withOpenClawTestState({ label: "e2e-limit-accept" }, async () => {
      const store = createPluginStateKeyedStore<string>("fixture-plugin", {
        namespace: "size",
        maxEntries: 10,
      });
      // JSON.stringify wraps a string in quotes (+2 bytes).
      // 65 534 chars → 65 536 bytes of JSON → exactly at limit.
      const boundary = "x".repeat(65_534);
      await expect(store.register("big", boundary)).resolves.toBeUndefined();
      await expect(store.lookup("big")).resolves.toBe(boundary);
    });
  });

  it("rejects a value one byte over 64 KB", async () => {
    await withOpenClawTestState({ label: "e2e-limit-reject" }, async () => {
      const store = createPluginStateKeyedStore<string>("fixture-plugin", {
        namespace: "size",
        maxEntries: 10,
      });
      // 65 535 chars → 65 537 bytes of JSON → over limit.
      const oversize = "x".repeat(65_535);
      await expect(store.register("big", oversize)).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });
    });
  });

  it("enforces the per-plugin live-row cap", async () => {
    await withOpenClawTestState({ label: "e2e-limit-plugin" }, async () => {
      // Spread MAX_ENTRIES_PER_PLUGIN rows across several namespaces so
      // namespace eviction never fires (each namespace has generous room).
      const nsCount = 10;
      const perNs = MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN / nsCount; // 100
      seedPluginStateEntriesForTests(
        Array.from({ length: MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN }, (_, index) => {
          const ns = Math.floor(index / perNs);
          const k = index % perNs;
          return {
            pluginId: "fixture-plugin",
            namespace: `ns-${ns}`,
            key: `k-${k}`,
            value: { ns, k },
          };
        }),
      );
      const store = createPluginStateKeyedStore("fixture-plugin", {
        namespace: "ns-0",
        maxEntries: perNs + 1,
      });

      // One more row tips over the plugin-wide limit.
      await expect(store.register("overflow", { boom: true })).rejects.toMatchObject({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      });
    });
  });

  it("evicts oldest entries when namespace maxEntries is exceeded", async () => {
    await withOpenClawTestState({ label: "e2e-limit-eviction" }, async () => {
      vi.useFakeTimers();
      const store = createPluginStateKeyedStore<number>("fixture-plugin", {
        namespace: "capped",
        maxEntries: 3,
      });

      vi.setSystemTime(1000);
      await store.register("a", 1);
      vi.setSystemTime(2000);
      await store.register("b", 2);
      vi.setSystemTime(3000);
      await store.register("c", 3);
      vi.setSystemTime(4000);
      await store.register("d", 4); // should evict "a"

      const entries = await store.entries();
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.key)).toEqual(["b", "c", "d"]);
      await expect(store.lookup("a")).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Failure safety
// ---------------------------------------------------------------------------
describe("failure safety", () => {
  it("gives a typed error for unsupported schema versions", async () => {
    await withOpenClawTestState({ label: "e2e-fail-schema" }, async () => {
      // Pre-seed the DB with a future schema version.
      mkdirSync(resolvePluginStateDir(), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(resolvePluginStateSqlitePath());
      db.exec("PRAGMA user_version = 99;");
      db.close();

      const store = createPluginStateKeyedStore("fixture-plugin", {
        namespace: "schema",
        maxEntries: 10,
      });
      const error = await store.register("k", { ok: true }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PluginStateStoreError);
      expect(error).toMatchObject({ code: "PLUGIN_STATE_SCHEMA_UNSUPPORTED" });
    });
  });

  it("probe returns redacted diagnostics without leaking stored values", async () => {
    await withOpenClawTestState({ label: "e2e-fail-probe" }, async () => {
      const result = probePluginStateStore();
      expect(result.ok).toBe(true);
      expect(result.dbPath).toContain("state.sqlite");
      expect(result.steps.length).toBeGreaterThanOrEqual(4);
      expect(result.steps.every((s) => s.ok)).toBe(true);

      // The probe's temporary stored value must not leak into the result.
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain("probe-value");
    });
  });

  it("close and reopen cycle is clean", async () => {
    await withOpenClawTestState({ label: "e2e-fail-reopen" }, async () => {
      const store = createPluginStateKeyedStore<{ v: number }>("fixture-plugin", {
        namespace: "reopen",
        maxEntries: 10,
      });
      await store.register("k", { v: 1 });

      // First close.
      closePluginStateSqliteStore();
      await expect(store.lookup("k")).resolves.toEqual({ v: 1 });

      // Second close (idempotent).
      closePluginStateSqliteStore();
      await expect(store.lookup("k")).resolves.toEqual({ v: 1 });

      // Write after reopen.
      await store.register("k", { v: 2 });
      await expect(store.lookup("k")).resolves.toEqual({ v: 2 });
    });
  });
});
