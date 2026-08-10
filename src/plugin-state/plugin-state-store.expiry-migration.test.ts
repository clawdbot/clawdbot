import { afterEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  countPluginStateLiveEntries,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import {
  seedPluginStateEntriesForTests,
  setMaxPluginStateEntriesPerPluginForTests,
} from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

afterEach(() => {
  vi.useRealTimers();
  setMaxPluginStateEntriesPerPluginForTests(undefined);
  resetPluginStateStoreForTests();
});

describe("plugin state keyed-store expiration migration", () => {
  it("revives only its namespace's expired entries without changing their creation order", async () => {
    await withOpenClawTestState({ label: "plugin-state-expiry-migration" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(5_000);
      seedPluginStateEntriesForTests([
        {
          pluginId: "slack",
          namespace: "threads",
          key: "oldest",
          value: 1,
          createdAt: 1_000,
          expiresAt: 2_000,
        },
        {
          pluginId: "slack",
          namespace: "threads",
          key: "retained",
          value: 2,
          createdAt: 2_000,
          expiresAt: 3_000,
        },
        {
          pluginId: "slack",
          namespace: "threads",
          key: "newest",
          value: 3,
          createdAt: 3_000,
          expiresAt: 4_000,
        },
        {
          pluginId: "slack",
          namespace: "other",
          key: "sibling",
          value: 4,
          createdAt: 1_000,
          expiresAt: 2_000,
        },
        {
          pluginId: "discord",
          namespace: "threads",
          key: "other-plugin",
          value: 5,
          createdAt: 1_000,
          expiresAt: 2_000,
        },
      ]);

      const store = createPluginStateSyncKeyedStore<number>("slack", {
        namespace: "threads",
        maxEntries: 2,
        clearExistingExpiryOnOpen: true,
      });

      expect(store.entries()).toEqual([
        { key: "retained", value: 2, createdAt: 2_000 },
        { key: "newest", value: 3, createdAt: 3_000 },
      ]);
      expect(store.lookup("oldest")).toBeUndefined();
      expect(
        createPluginStateSyncKeyedStore("slack", { namespace: "other", maxEntries: 10 }).lookup(
          "sibling",
        ),
      ).toBeUndefined();
      expect(
        createPluginStateSyncKeyedStore("discord", { namespace: "threads", maxEntries: 10 }).lookup(
          "other-plugin",
        ),
      ).toBeUndefined();
      expect(
        createPluginStateSyncKeyedStore<number>("slack", {
          namespace: "threads",
          maxEntries: 2,
        }).lookup("retained"),
      ).toBe(2);
    });
  });

  it("keeps revived entries within the plugin-wide capacity", async () => {
    await withOpenClawTestState({ label: "plugin-state-expiry-migration" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(5_000);
      setMaxPluginStateEntriesPerPluginForTests(2);
      seedPluginStateEntriesForTests([
        {
          pluginId: "slack",
          namespace: "threads",
          key: "oldest",
          value: 1,
          createdAt: 1_000,
          expiresAt: 2_000,
        },
        {
          pluginId: "slack",
          namespace: "threads",
          key: "newest",
          value: 2,
          createdAt: 2_000,
          expiresAt: 3_000,
        },
        { pluginId: "slack", namespace: "durable", key: "sibling", value: 3, createdAt: 3_000 },
      ]);

      const store = createPluginStateSyncKeyedStore<number>("slack", {
        namespace: "threads",
        maxEntries: 10,
        clearExistingExpiryOnOpen: true,
      });

      expect(store.entries()).toEqual([{ key: "newest", value: 2, createdAt: 2_000 }]);
      expect(countPluginStateLiveEntries("slack")).toBe(2);
      expect(
        createPluginStateSyncKeyedStore<number>("slack", {
          namespace: "durable",
          maxEntries: 10,
        }).lookup("sibling"),
      ).toBe(3);
    });
  });

  it("rejects transient writes to migrated stores while preserving normal per-record TTLs", async () => {
    await withOpenClawTestState({ label: "plugin-state-expiry-migration" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(5_000);
      seedPluginStateEntriesForTests([
        {
          pluginId: "slack",
          namespace: "threads",
          key: "migrated",
          value: 1,
          createdAt: 1_000,
          expiresAt: 2_000,
        },
      ]);

      const options = {
        namespace: "threads",
        maxEntries: 10,
        clearExistingExpiryOnOpen: true,
      };
      const existingStore = createPluginStateSyncKeyedStore<number>("slack", {
        namespace: "threads",
        maxEntries: 10,
      });
      const store = createPluginStateSyncKeyedStore<number>("slack", options);
      const reopenedWithoutMigration = createPluginStateSyncKeyedStore<number>("slack", {
        namespace: "threads",
        maxEntries: 10,
      });
      const updateValue = vi.fn(() => 4);

      for (const handle of [existingStore, store, reopenedWithoutMigration]) {
        expect(() => handle.register("transient-register", 2, { ttlMs: 1_000 })).toThrow(
          PluginStateStoreError,
        );
        expect(() => handle.registerIfAbsent("transient-claim", 3, { ttlMs: 1_000 })).toThrow(
          PluginStateStoreError,
        );
        expect(() => handle.update?.("migrated", updateValue, { ttlMs: 1_000 })).toThrow(
          PluginStateStoreError,
        );
      }
      expect(updateValue).not.toHaveBeenCalled();

      store.register("durable-register", 2);
      expect(store.registerIfAbsent("durable-claim", 3)).toBe(true);
      expect(store.update?.("migrated", (current) => (current ?? 0) + 1)).toBe(true);

      const reopened = createPluginStateSyncKeyedStore<number>("slack", options);
      expect(reopened.entries()).toEqual([
        { key: "durable-claim", value: 3, createdAt: 5_000 },
        { key: "durable-register", value: 2, createdAt: 5_000 },
        { key: "migrated", value: 2, createdAt: 5_000 },
      ]);

      const normalStore = createPluginStateSyncKeyedStore<number>("discord", {
        namespace: "threads",
        maxEntries: 10,
      });
      normalStore.register("transient", 4, { ttlMs: 1_000 });
      expect(normalStore.entries()).toEqual([
        { key: "transient", value: 4, createdAt: 5_000, expiresAt: 6_000 },
      ]);

      vi.advanceTimersByTime(1_001);
      expect(normalStore.lookup("transient")).toBeUndefined();
      expect(reopened.lookup("migrated")).toBe(2);
      expect(reopened.lookup("durable-register")).toBe(2);
      expect(reopened.lookup("durable-claim")).toBe(3);
    });
  });

  it("rejects clearing existing expiry for expiring or reject-new namespaces", async () => {
    await withOpenClawTestState({ label: "plugin-state-expiry-migration" }, async () => {
      expect(() =>
        createPluginStateSyncKeyedStore("slack", {
          namespace: "expiring",
          maxEntries: 10,
          defaultTtlMs: 1_000,
          clearExistingExpiryOnOpen: true,
        }),
      ).toThrow(PluginStateStoreError);
      expect(() =>
        createPluginStateSyncKeyedStore("slack", {
          namespace: "reject-new",
          maxEntries: 10,
          overflowPolicy: "reject-new",
          clearExistingExpiryOnOpen: true,
        }),
      ).toThrow(PluginStateStoreError);
    });
  });
});
