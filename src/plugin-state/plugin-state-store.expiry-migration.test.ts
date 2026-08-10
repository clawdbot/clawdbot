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
