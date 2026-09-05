import { DeleteQueryNode } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { getNodeSqliteKysely } from "./kysely-sync.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";

describe("SQLite audit record store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabase();
  });

  it("keeps the newest configured number of rows per scope", async () => {
    await withTestDir({ prefix: "openclaw-audit-store-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "bounded-test",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("one", { value: 1 }, 1);
      store.register("two", { value: 2 }, 2);
      store.register("three", { value: 3 }, 3);

      expect(store.size()).toBe(2);
      expect(store.entries().map((entry) => entry.key)).toEqual(["two", "three"]);
    });
  });

  it("reads bounded newest-first pages by sequence", async () => {
    await withTestDir({ prefix: "openclaw-audit-store-latest-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "latest-test",
        maxEntries: 10,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("one", { value: 1 }, 100);
      store.register("two", { value: 2 }, 100);
      store.register("three", { value: 3 }, 50);

      const firstPage = store.latest({ limit: 2 });
      expect(firstPage.map((entry) => entry.key)).toEqual(["three", "two"]);
      expect(firstPage.map((entry) => entry.sequence)).toEqual([3, 2]);
      expect(store.latest({ limit: 2, beforeSequence: firstPage.at(-1)!.sequence })).toEqual([
        expect.objectContaining({ key: "one", sequence: 1 }),
      ]);
      expect(store.latest({ limit: 0 })).toEqual([]);
    });
  });

  it("preserves insertion order and prunes the oldest row when timestamps tie", async () => {
    await withTestDir({ prefix: "openclaw-audit-store-ties-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "tied-timestamps",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("z-first", { value: 1 }, 1);
      store.register("a-second", { value: 2 }, 1);
      expect(store.entries().map((entry) => entry.key)).toEqual(["z-first", "a-second"]);

      store.register("m-third", { value: 3 }, 1);
      expect(store.entries().map((entry) => entry.key)).toEqual(["a-second", "m-third"]);
    });
  });

  it("prunes by insertion order when wall-clock timestamps move", async () => {
    await withTestDir({ prefix: "openclaw-audit-store-clock-skew-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "clock-skew",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("future-first", { value: 1 }, 4_000_000_000_000);
      store.register("past-second", { value: 2 }, 1);
      store.register("current-third", { value: 3 }, 2_000_000_000_000);

      expect(store.entries().map((entry) => entry.key)).toEqual(["past-second", "current-third"]);
    });
  });

  it("prunes a legacy batch with one delete while preserving runtime rows and other scopes", async () => {
    await withTestDir({ prefix: "openclaw-audit-store-batch-" }, async (stateDir) => {
      const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
      const store = createSqliteAuditRecordStore<{ value: number }>({
        ...options,
        scope: "batch-test",
        maxEntries: 3,
      });
      const sibling = createSqliteAuditRecordStore<{ value: number }>({
        ...options,
        scope: "other-scope",
        maxEntries: 3,
      });
      store.register("runtime", { value: 100 }, 0);
      sibling.register("legacy-0", { value: 200 }, 1);
      const { db } = openOpenClawStateDatabase(options);
      const compile = vi.spyOn(getNodeSqliteKysely(db).getExecutor(), "compileQuery");

      store.registerLegacyMany(
        Array.from({ length: 50 }, (_, index) => ({
          key: `legacy-${index}`,
          value: { value: index },
          createdAt: 100 - index,
        })),
      );

      expect(store.entries().map((entry) => entry.key)).toEqual([
        "legacy-48",
        "legacy-49",
        "runtime",
      ]);
      expect(sibling.entries()).toEqual([{ key: "legacy-0", value: { value: 200 }, createdAt: 1 }]);
      expect(
        compile.mock.results.filter(
          (result) => result.type === "return" && DeleteQueryNode.is(result.value.query),
        ),
      ).toHaveLength(1);
    });
  });

  it.each(["register", "upsert", "compareAndSet"] as const)(
    "protects the oldest key during %s without changing its insertion age",
    async (operation) => {
      await withTestDir({ prefix: "openclaw-audit-store-protected-" }, async (stateDir) => {
        const options = {
          scope: "protected-test",
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        };
        const seed = createSqliteAuditRecordStore<{ value: number }>({
          ...options,
          maxEntries: 4,
        });
        for (const [index, key] of ["old\0key", "second", "third", "newest"].entries()) {
          seed.register(key, { value: index }, 1);
        }
        const store = createSqliteAuditRecordStore<{ value: number }>({
          ...options,
          maxEntries: 2,
        });
        if (operation === "compareAndSet") {
          expect(store.compareAndSet("old\0key", { value: 0 }, { value: 9 }, 0)).toBe(true);
        } else {
          store[operation]("old\0key", { value: 9 }, 0);
        }
        expect(store.latest({ limit: 4 })).toEqual([
          { key: "newest", value: { value: 3 }, createdAt: 1, sequence: 4 },
          {
            key: "old\0key",
            value: { value: operation === "register" ? 0 : 9 },
            createdAt: operation === "register" ? 1 : 0,
            sequence: 1,
          },
        ]);
      });
    },
  );

  it("rolls back failed pruning and lets a caller-owned transaction continue", async () => {
    await withTestDir({ prefix: "openclaw-audit-store-rollback-" }, async (stateDir) => {
      const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
      const store = createSqliteAuditRecordStore<{ value: number }>({
        ...options,
        scope: "rollback-test",
        maxEntries: 2,
      });
      store.register("one", { value: 1 }, 1);
      store.register("two", { value: 2 }, 2);
      const before = store.latest({ limit: 3 });
      const { db } = openOpenClawStateDatabase(options);
      db.exec(`
        CREATE TEMP TRIGGER reject_audit_pruning BEFORE DELETE ON diagnostic_events
        WHEN OLD.scope = 'rollback-test' AND OLD.event_key = 'one'
        BEGIN SELECT RAISE(ABORT, 'audit pruning refused'); END;
      `);
      const append = () => store.register("three", { value: 3 }, 3);
      expect(append).toThrow("audit pruning refused");
      expect(store.latest({ limit: 3 })).toEqual(before);

      runOpenClawStateWriteTransaction(() => {
        expect(append).toThrow("audit pruning refused");
        store.upsert("two", { value: 20 }, 20);
      }, options);
      expect(store.latest({ limit: 3 })).toEqual([
        { key: "two", value: { value: 20 }, createdAt: 20, sequence: 2 },
        before[1],
      ]);
      db.exec("DROP TRIGGER reject_audit_pruning");
      append();
      expect(store.entries().map((entry) => entry.key)).toEqual(["two", "three"]);
    });
  });

  it("keeps keyed mutations atomic without changing insertion age", async () => {
    await withTestDir({ prefix: "openclaw-audit-store-upsert-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "upsert-test",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("one", { value: 1 }, 1);
      store.register("two", { value: 2 }, 2);
      store.upsert("one", { value: 3 }, 3);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "two", value: { value: 2 }, createdAt: 2, sequence: 2 },
        { key: "one", value: { value: 3 }, createdAt: 3, sequence: 1 },
      ]);

      expect(store.compareAndSet("one", { value: 3 }, { value: 4 }, 4)).toBe(true);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "two", value: { value: 2 }, createdAt: 2, sequence: 2 },
        { key: "one", value: { value: 4 }, createdAt: 4, sequence: 1 },
      ]);

      expect(store.compareAndSet("one", { value: 999 }, null)).toBe(false);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "two", value: { value: 2 }, createdAt: 2, sequence: 2 },
        { key: "one", value: { value: 4 }, createdAt: 4, sequence: 1 },
      ]);

      expect(store.compareAndSet("one", { value: 4 }, null)).toBe(true);
      expect(store.compareAndSet("three", null, { value: 5 }, 5)).toBe(true);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "three", value: { value: 5 }, createdAt: 5, sequence: 3 },
        { key: "two", value: { value: 2 }, createdAt: 2, sequence: 2 },
      ]);

      expect(store.compareAndSet("four", null, { value: 6 }, 6)).toBe(true);
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "four", value: { value: 6 }, createdAt: 6, sequence: 4 },
        { key: "three", value: { value: 5 }, createdAt: 5, sequence: 3 },
      ]);

      store.delete("four");
      expect(store.latest({ limit: 2 })).toEqual([
        { key: "three", value: { value: 5 }, createdAt: 5, sequence: 3 },
      ]);
    });
  });

  it("orders legacy batches before existing runtime rows", async () => {
    await withTestDir({ prefix: "openclaw-audit-store-legacy-order-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "legacy-order",
        maxEntries: 4,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("runtime", { value: 3 }, 3);
      store.registerLegacyMany([
        { key: "legacy-one", value: { value: 1 }, createdAt: 1 },
        { key: "legacy-two", value: { value: 2 }, createdAt: 2 },
      ]);

      expect(store.entries().map((entry) => entry.key)).toEqual([
        "legacy-one",
        "legacy-two",
        "runtime",
      ]);
    });
  });
});
