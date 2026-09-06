import * as lancedb from "@lancedb/lancedb";
import { describe, expect, test } from "vitest";
import { MemoryDB } from "./lancedb-store.js";
import { installTmpDirHarness } from "./test-helpers.js";

describe("MemoryDB agent isolation", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-scope-" });

  test("cancels a timed-out native search and keeps the table usable", async () => {
    const db = new MemoryDB(getDbPath(), 2);
    try {
      const stored = await db.store("alpha", {
        text: "alpha private preference",
        vector: [1, 0],
        importance: 0.8,
        category: "preference",
      });

      await expect(db.search("alpha", [1, 0], 5, 0, { timeoutMs: 0 })).rejects.toThrow(
        "Query timeout",
      );
      await expect(db.search("alpha", [1, 0], 5, 0, { timeoutMs: 5_000 })).resolves.toMatchObject([
        { entry: { id: stored.id, text: "alpha private preference" } },
      ]);
    } finally {
      db.close();
    }
  });

  test("scopes store, search, list, query, count, delete, and restart reads", async () => {
    const db = new MemoryDB(getDbPath(), 2);
    const alpha = await db.store("alpha", {
      text: "alpha private preference",
      vector: [1, 0],
      importance: 0.8,
      category: "preference",
    });
    await db.store("beta", {
      text: "beta private preference",
      vector: [1, 0],
      importance: 0.9,
      category: "preference",
    });

    await expect(db.search("alpha", [1, 0], 5, 0)).resolves.toMatchObject([
      { entry: { id: alpha.id, text: "alpha private preference" } },
    ]);
    await expect(db.list("beta")).resolves.toMatchObject([{ text: "beta private preference" }]);
    await expect(db.count("alpha")).resolves.toBe(1);
    await expect(
      db.query("alpha", {
        columns: ["id", "text"],
        filter: { column: "category", operator: "=", value: "preference" },
      }),
    ).resolves.toMatchObject([{ id: alpha.id, text: "alpha private preference" }]);

    await expect(db.delete("beta", alpha.id)).resolves.toBe(false);
    await expect(db.count("alpha")).resolves.toBe(1);
    db.close();

    const reopened = new MemoryDB(getDbPath(), 2);
    await expect(reopened.list("alpha")).resolves.toMatchObject([
      { id: alpha.id, text: "alpha private preference" },
    ]);
    await expect(reopened.list("beta")).resolves.toMatchObject([
      { text: "beta private preference" },
    ]);
    reopened.close();
  });

  test("rejects search when a persisted table is reopened with a different vector dimension", async () => {
    const db = new MemoryDB(getDbPath(), 2);
    await db.store("main", {
      text: "fixed-size vector",
      vector: [1, 0],
      importance: 0.7,
      category: "fact",
    });
    db.close();

    const incompatible = new MemoryDB(getDbPath(), 3);
    await expect(incompatible.search("main", [1, 0, 0], 5, 0)).rejects.toThrow(
      "No vector column found to match with the query vector dimension: 3",
    );
    incompatible.close();
  });

  test("refuses an unscoped legacy table until doctor migrates it", async () => {
    const connection = await lancedb.connect(getDbPath());
    const table = await connection.createTable("memories", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "legacy shared memory",
        vector: [1, 0],
        importance: 0.7,
        category: "fact",
        createdAt: 1,
      },
    ]);
    table.close();
    connection.close();

    const db = new MemoryDB(getDbPath(), 2);
    await expect(db.count("main")).rejects.toThrow(
      'Run "openclaw doctor --fix" to assign legacy rows to the default agent',
    );
    await expect(db.count("main")).rejects.toThrow(
      'Run "openclaw doctor --fix" to assign legacy rows to the default agent',
    );
    db.close();
  });
});
