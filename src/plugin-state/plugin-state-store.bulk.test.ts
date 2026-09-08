import { ok } from "@openclaw/normalization-core/result";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateDatabase,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";

afterEach(() => resetPluginStateStoreForTests());

describe("plugin state bulk reads", () => {
  it("bulk reads exact keys positionally with sync/async parity across reopen", async () => {
    await withOpenClawTestState({ label: "plugin-state-bulk-0" }, async () => {
      const options = { namespace: "bulk", maxEntries: 20 };
      const sync = createPluginStateSyncKeyedStore<{ index: number }>("discord", options);
      const asyncStore = createPluginStateKeyedStore<{ index: number }>("discord", options);
      const keys = [
        "ten:10",
        "two:2",
        "nul\0tail",
        "literal\\u0000",
        "lone\ud800",
        "__proto__",
      ] as const;
      keys.forEach((key, index) => sync.register(key, { index }));
      createPluginStateSyncKeyedStore("telegram", options).register(keys[0], { index: 99 });
      createPluginStateSyncKeyedStore("discord", { ...options, namespace: "other" }).register(
        keys[0],
        { index: 98 },
      );
      const now = Date.now();
      seedPluginStateEntriesForTests([
        { pluginId: "discord", namespace: "bulk", key: "expired", value: {}, expiresAt: now },
      ]);
      const request = [keys[3], "missing", keys[0], "expired", ...keys, ` ${keys[1]} `];
      const expected = [
        { index: 3 },
        undefined,
        { index: 0 },
        undefined,
        ...keys.map((_, index) => ({ index })),
        { index: 1 },
      ];
      for (let connection = 0; connection < 2; connection++) {
        expect(sync.lookupMany(request)).toEqual(expected.map(ok));
        await expect(asyncStore.lookupMany(request)).resolves.toEqual(expected.map(ok));
        const duplicates = sync.lookupMany([keys[0], keys[0]]);
        expect(duplicates[0]?.ok && duplicates[0].value).not.toBe(
          duplicates[1]?.ok && duplicates[1].value,
        );
        if (connection > 0) {
          expect(isOpenClawStateDatabaseOpen()).toBe(false);
        }
        closePluginStateDatabase();
      }
      expect(isOpenClawStateDatabaseOpen()).toBe(false);
    });
  });

  it("bulk reads use fresh expiry and preserve corrupt JSON errors", async () => {
    await withOpenClawTestState({ label: "plugin-state-bulk-1" }, async () => {
      const options = { namespace: "bulk-errors", maxEntries: 10 };
      const sync = createPluginStateSyncKeyedStore<number>("discord", options);
      const asyncStore = createPluginStateKeyedStore<number>("discord", options);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        sync.register("short", 1, { ttlMs: 100 });
        sync.register("long", 2);
        expect(sync.lookupMany(["short", "long"])).toEqual([ok(1), ok(2)]);
        clock.mockReturnValue(now + 100);
        await expect(asyncStore.lookupMany(["short", "long"])).resolves.toEqual([
          ok(undefined),
          ok(2),
        ]);
        const { db } = openOpenClawStateDatabase();
        db.prepare(
          "UPDATE plugin_state_entries SET value_json = ? WHERE namespace = ? AND entry_key = ?",
        ).run("invalid JSON", "bulk-errors", "long");
        const corrupt = {
          ok: false,
          error: expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT", operation: "lookup" }),
        };
        expect(sync.lookupMany(["short", "long", "short"])).toEqual([
          ok(undefined),
          corrupt,
          ok(undefined),
        ]);
        await expect(asyncStore.lookupMany(["long"])).resolves.toEqual([corrupt]);
        expect(() => sync.lookup("long")).toThrowError(corrupt.error);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("bounds and validates every bulk key before reading, with one native query", async () => {
    await withOpenClawTestState({ label: "plugin-state-bulk-2" }, async () => {
      const store = createPluginStateSyncKeyedStore<number>("discord", {
        namespace: "bulk-bounds",
        maxEntries: 10,
      });
      const asyncStore = createPluginStateKeyedStore<number>("discord", {
        namespace: "bulk-bounds",
        maxEntries: 10,
      });
      store.register("key", 1);
      const { db } = openOpenClawStateDatabase();
      const reads = trackSqliteStatementExecutions(db, ["reads"], (sql) =>
        sql.startsWith("select ") && sql.includes('"plugin_state_entries"') ? "reads" : null,
      );
      try {
        expect(store.lookupMany([])).toEqual([]);
        expect(() => store.lookupMany(["key", " "])).toThrowError(
          expect.objectContaining({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "lookup" }),
        );
        await expect(
          asyncStore.lookupMany(Array.from({ length: 10_001 }, () => "key")),
        ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT", operation: "lookup" });
        expect(reads.counts.reads).toBe(0);
        expect(store.lookupMany(Array.from({ length: 10_000 }, () => "key"))).toEqual(
          Array.from({ length: 10_000 }, () => ok(1)),
        );
        expect(reads.counts.reads).toBe(1);
        expect(reads.rowCounts.reads).toBe(1);
      } finally {
        reads.restore();
      }
    });
  });
});
