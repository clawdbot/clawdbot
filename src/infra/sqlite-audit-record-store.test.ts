import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";

describe("SQLite audit record store", () => {
  afterEach(() => {
    closeOpenClawStateDatabase();
  });

  it("keeps the newest configured number of rows per scope", async () => {
    await withTempDir({ prefix: "openclaw-audit-store-" }, async (stateDir) => {
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
    await withTempDir({ prefix: "openclaw-audit-store-latest-" }, async (stateDir) => {
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
    await withTempDir({ prefix: "openclaw-audit-store-ties-" }, async (stateDir) => {
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
    await withTempDir({ prefix: "openclaw-audit-store-clock-skew-" }, async (stateDir) => {
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

  it("commits batch inserts with one retention pass", async () => {
    await withTempDir({ prefix: "openclaw-audit-store-batch-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "batch-test",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.registerLegacyMany([
        { key: "one", value: { value: 1 }, createdAt: 1 },
        { key: "two", value: { value: 2 }, createdAt: 2 },
        { key: "three", value: { value: 3 }, createdAt: 3 },
      ]);

      expect(store.entries().map((entry) => entry.key)).toEqual(["two", "three"]);
    });
  });

  it("updates a retained key without consuming another bounded entry", async () => {
    await withTempDir({ prefix: "openclaw-audit-store-upsert-" }, async (stateDir) => {
      const store = createSqliteAuditRecordStore<{ value: number }>({
        scope: "upsert-test",
        maxEntries: 2,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      store.register("one", { value: 1 }, 1);
      store.register("two", { value: 2 }, 2);
      store.upsert("one", { value: 3 }, 3);

      expect(store.size()).toBe(2);
      expect(store.entries()).toEqual([
        { key: "one", value: { value: 3 }, createdAt: 3 },
        { key: "two", value: { value: 2 }, createdAt: 2 },
      ]);
    });
  });

  it("orders legacy batches before existing runtime rows", async () => {
    await withTempDir({ prefix: "openclaw-audit-store-legacy-order-" }, async (stateDir) => {
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
