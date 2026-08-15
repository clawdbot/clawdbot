// Plugin state rekey tests cover atomic key moves for migration paths (#118370).
import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import { clearPluginStateStoreForTests } from "./plugin-state-store.test-helpers.js";

let testState: OpenClawTestState | undefined;

beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-store-rekey" });
  rmSync(path.dirname(resolveOpenClawStateSqlitePath()), { recursive: true, force: true });
});

beforeEach(() => {
  testState?.applyEnv();
  clearPluginStateStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(async () => {
  resetPluginStateStoreForTests();
  await testState?.cleanup();
});

describe("plugin state keyed store rekey", () => {
  it("rekeys atomically, preserving age and TTL, and never overwrites a live target", async () => {
    vi.useFakeTimers();
    const store = createPluginStateKeyedStore<{ version: number }>("memory-wiki", {
      namespace: "ownership",
      maxEntries: 2,
      overflowPolicy: "reject-new",
    });
    if (!store.rekey) {
      throw new Error("plugin state rekey unavailable");
    }
    vi.setSystemTime(1000);
    await store.register("legacy", { version: 1 });
    vi.setSystemTime(2000);
    await store.register("sibling", { version: 9 }, { ttlMs: 60_000 });

    // The namespace is at its reject-new cap: a register would fail, but the
    // slot-neutral rekey moves key and value in one transaction.
    vi.setSystemTime(3000);
    await expect(store.rekey("legacy", "scoped", { version: 2 })).resolves.toBe("rekeyed");
    await expect(store.lookup("legacy")).resolves.toBeUndefined();
    await expect(store.lookup("scoped")).resolves.toEqual({ version: 2 });
    // created_at survives the move, so the rekeyed row keeps its age order.
    const entries = await store.entries();
    expect(entries).toEqual([
      expect.objectContaining({ key: "scoped", value: { version: 2 }, createdAt: 1000 }),
      expect.objectContaining({ key: "sibling", value: { version: 9 }, createdAt: 2000 }),
    ]);
    // The sibling row's TTL is untouched by the rekey.
    expect(entries[1]?.expiresAt).toBe(62_000);

    // A live target is never overwritten: the source row stays put.
    await expect(store.rekey("scoped", "sibling", { version: 3 })).resolves.toBe("conflict");
    await expect(store.lookup("scoped")).resolves.toEqual({ version: 2 });
    await expect(store.lookup("sibling")).resolves.toMatchObject({ version: 9 });

    // Missing source: only counts as rekeyed when the target already holds a
    // live row, so reruns after a partial migration stay idempotent.
    await expect(store.rekey("gone", "absent", { version: 1 })).resolves.toBe("missing");
    await expect(store.rekey("gone", "scoped", { version: 1 })).resolves.toBe("rekeyed");
  });

  it("sync store rekeys with the same contract", async () => {
    const store = createPluginStateSyncKeyedStore<{ version: number }>("memory-wiki", {
      namespace: "ownership-sync",
      maxEntries: 10,
    });
    if (!store.rekey) {
      throw new Error("plugin state rekey unavailable");
    }
    store.register("legacy", { version: 1 });
    expect(store.rekey("legacy", "scoped", { version: 2 })).toBe("rekeyed");
    expect(store.lookup("legacy")).toBeUndefined();
    expect(store.lookup("scoped")).toEqual({ version: 2 });
  });
});
