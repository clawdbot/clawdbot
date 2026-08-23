import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  countPluginStateLiveEntries,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.js";
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
  setMaxPluginStateEntriesPerPluginForTests,
} from "./plugin-state-store.test-helpers.js";

let testState: OpenClawTestState | undefined;

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-expiry" });
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

describe("plugin state expiry cleanup", () => {
  it("registerIfAbsent replaces an expired target beyond the namespace cleanup batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_200);
    seedPluginStateEntriesForTests([
      ...Array.from({ length: 1_025 }, (_, index) => ({
        pluginId: "discord",
        namespace: "claims-batched-expiry",
        key: `expired-${String(index).padStart(4, "0")}`,
        value: { index },
        createdAt: index,
        expiresAt: 1_100,
      })),
      {
        pluginId: "discord",
        namespace: "claims-batched-expiry",
        key: "zz-target",
        value: { version: 1 },
        createdAt: 5_000,
        expiresAt: 1_100,
      },
    ]);
    const store = createPluginStateKeyedStore<{ version: number }>("discord", {
      namespace: "claims-batched-expiry",
      maxEntries: 10,
    });

    await expect(store.registerIfAbsent("zz-target", { version: 2 })).resolves.toBe(true);
    await expect(store.lookup("zz-target")).resolves.toEqual({ version: 2 });
    expect(sweepExpiredPluginStateEntries()).toBe(1);
  });

  it("sweeps expired plugin state in bounded batches without touching live rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    seedPluginStateEntriesForTests([
      ...Array.from({ length: 2_050 }, (_, index) => ({
        pluginId: index % 2 === 0 ? "discord" : "telegram",
        namespace: "batched-expiry",
        key: `expired-${index}`,
        value: { index },
        expiresAt: 1_000 + Math.floor(index / 2),
      })),
      {
        pluginId: "discord",
        namespace: "batched-expiry",
        key: "permanent",
        value: { durable: true },
      },
      {
        pluginId: "discord",
        namespace: "batched-expiry",
        key: "live",
        value: { live: true },
        expiresAt: 4_000,
      },
      {
        pluginId: "sibling-plugin",
        namespace: "batched-expiry",
        key: "permanent",
        value: { sibling: true },
      },
    ]);

    expect(sweepExpiredPluginStateEntries()).toBe(1_024);
    expect(sweepExpiredPluginStateEntries()).toBe(1_024);
    expect(sweepExpiredPluginStateEntries()).toBe(2);
    expect(sweepExpiredPluginStateEntries()).toBe(0);

    const store = createPluginStateKeyedStore("discord", {
      namespace: "batched-expiry",
      maxEntries: 10,
    });
    const sibling = createPluginStateKeyedStore("sibling-plugin", {
      namespace: "batched-expiry",
      maxEntries: 10,
    });
    await expect(store.lookup("permanent")).resolves.toEqual({ durable: true });
    await expect(store.lookup("live")).resolves.toEqual({ live: true });
    await expect(sibling.lookup("permanent")).resolves.toEqual({ sibling: true });
  });

  it.each(["register", "update"] as const)(
    "bounds expired namespace cleanup during %s without touching sibling rows",
    async (operation) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_200);
      seedPluginStateEntriesForTests([
        ...Array.from({ length: 1_031 }, (_, index) => ({
          pluginId: "discord",
          namespace: "namespace-batched-expiry",
          key: `expired-${index}`,
          value: { index },
          expiresAt: 1_100,
        })),
        {
          pluginId: "discord",
          namespace: "namespace-batched-expiry",
          key: "permanent",
          value: { durable: true },
        },
        {
          pluginId: "discord",
          namespace: "sibling-namespace",
          key: "expired",
          value: { sibling: true },
          expiresAt: 1_100,
        },
        {
          pluginId: "sibling-plugin",
          namespace: "namespace-batched-expiry",
          key: "expired",
          value: { sibling: true },
          expiresAt: 1_100,
        },
      ]);
      const store = createPluginStateSyncKeyedStore<{ durable?: boolean; fresh?: boolean }>(
        "discord",
        { namespace: "namespace-batched-expiry", maxEntries: 10 },
      );

      if (operation === "register") {
        store.register("fresh", { fresh: true });
      } else {
        expect(store.update?.("fresh", () => ({ fresh: true }))).toBe(true);
      }

      expect(store.lookup("fresh")).toEqual({ fresh: true });
      expect(store.lookup("permanent")).toEqual({ durable: true });
      expect(sweepExpiredPluginStateEntries()).toBe(9);
    },
  );

  it("rolls back bounded expiry cleanup when the enclosing namespace write fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_200);
    setMaxPluginStateEntriesPerPluginForTests(2);
    seedPluginStateEntriesForTests([
      ...Array.from({ length: 1_031 }, (_, index) => ({
        pluginId: "discord",
        namespace: "rollback-expiry",
        key: `expired-${index}`,
        value: { index },
        expiresAt: 1_100,
      })),
      {
        pluginId: "discord",
        namespace: "durable-sibling",
        key: "first",
        value: { durable: 1 },
      },
      {
        pluginId: "discord",
        namespace: "durable-sibling",
        key: "second",
        value: { durable: 2 },
      },
    ]);
    const store = createPluginStateKeyedStore("discord", {
      namespace: "rollback-expiry",
      maxEntries: 10,
    });

    await expect(store.register("fresh", { fresh: true })).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    expect(sweepExpiredPluginStateEntries()).toBe(1_024);
    expect(sweepExpiredPluginStateEntries()).toBe(7);
    await expect(store.lookup("fresh")).resolves.toBeUndefined();
    expect(countPluginStateLiveEntries("discord")).toBe(2);
  });
});
