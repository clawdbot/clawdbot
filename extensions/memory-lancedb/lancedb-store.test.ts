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

  test("keeps a pre-scope table fully usable in legacy mode until doctor migrates it", async () => {
    // Upgrade safety: a table from a release with agentId but no scope column
    // must keep working exactly as before this feature — no runtime mutation,
    // no unavailability. Unscoped operations behave as pre-scope, scoped reads
    // match nothing, and only a scoped write is refused with a Doctor pointer.
    const legacyId = "11111111-1111-4111-8111-111111111111";
    const connection = await lancedb.connect(getDbPath());
    const table = await connection.createTable("memories", [
      {
        id: legacyId,
        text: "agent-isolated memory without scope",
        vector: [1, 0],
        importance: 0.7,
        category: "fact",
        createdAt: 1,
        agentId: "main",
      },
    ]);
    table.close();
    connection.close();

    const db = new MemoryDB(getDbPath(), 2);
    // Unscoped reads work unchanged (rows are all global).
    await expect(db.count("main")).resolves.toBe(1);
    const agentWide = await db.search("main", [1, 0], 5, 0);
    expect(agentWide.map((r) => r.entry.id)).toEqual([legacyId]);
    const globalView = await db.search("main", [1, 0], 5, 0, undefined, "");
    expect(globalView.map((r) => r.entry.id)).toEqual([legacyId]);
    expect(globalView[0]?.entry.scope).toBe("");
    // A scoped read matches nothing (no partitioned rows can exist).
    await expect(db.search("main", [1, 0], 5, 0, undefined, "alpha")).resolves.toEqual([]);
    // getScopeById reports the legacy row as global.
    await expect(db.getScopeById("main", legacyId)).resolves.toBe("");
    // Global writes keep working with the pre-scope row shape...
    const stored = await db.store("main", {
      text: "a new global memory",
      vector: [0, 1],
      importance: 0.6,
      category: "fact",
    });
    await expect(db.count("main")).resolves.toBe(2);
    await expect(db.getScopeById("main", stored.id)).resolves.toBe("");
    // ...while a partitioned write is refused rather than silently mis-scoped.
    await expect(
      db.store("main", {
        text: "a scoped memory",
        vector: [0, 1],
        importance: 0.6,
        category: "fact",
        scope: "alpha",
      }),
    ).rejects.toThrow('Run "openclaw doctor --fix" to add the scope column');
    await expect(db.count("main")).resolves.toBe(2);
    // Operator inspection stays available: list reports every row as global,
    // selecting the absent scope column is dropped from query output, an
    // explicit scope filter is refused with the Doctor pointer, and the stats
    // split shows zero partitioned rows.
    const listed = await db.list("main");
    expect(listed).toHaveLength(2);
    expect(listed.every((entry) => entry.scope === "")).toBe(true);
    const queried = await db.query("main", { columns: ["id", "scope"] });
    expect(queried).toHaveLength(2);
    expect(queried.every((row) => !("scope" in row))).toBe(true);
    await expect(
      db.query("main", {
        columns: ["id"],
        filter: { column: "scope", operator: "=", value: "alpha" },
      }),
    ).rejects.toThrow('Run "openclaw doctor --fix" to add the scope column');
    await expect(db.countScoped("main")).resolves.toBe(0);
    db.close();
  });

  test("partitions search by scope while unscoped search stays agent-wide", async () => {
    const db = new MemoryDB(getDbPath(), 2);
    const globalEntry = await db.store("main", {
      text: "a global memory",
      vector: [1, 0],
      importance: 0.8,
      category: "fact",
    });
    const alphaEntry = await db.store("main", {
      text: "an alpha-scoped memory",
      vector: [1, 0],
      importance: 0.8,
      category: "fact",
      scope: "alpha",
    });
    await db.store("other-agent", {
      text: "another agent's alpha memory",
      vector: [1, 0],
      importance: 0.8,
      category: "fact",
      scope: "alpha",
    });

    // scope "" = global rows only; a scoped row shares the exact vector but
    // must stay hidden from the global view.
    const globalOnly = await db.search("main", [1, 0], 5, 0, undefined, "");
    expect(globalOnly.map((r) => r.entry.id)).toEqual([globalEntry.id]);
    expect(globalOnly[0]?.entry.scope).toBe("");

    // A scoped search sees exactly that partition — never another agent's rows.
    const alphaOnly = await db.search("main", [1, 0], 5, 0, undefined, "alpha");
    expect(alphaOnly.map((r) => r.entry.id)).toEqual([alphaEntry.id]);
    expect(alphaOnly[0]?.entry.scope).toBe("alpha");

    // No scope argument keeps the pre-scope agent-wide behavior.
    const agentWide = await db.search("main", [1, 0], 5, 0);
    expect(agentWide.map((r) => r.entry.id).toSorted()).toEqual(
      [globalEntry.id, alphaEntry.id].toSorted(),
    );

    // getScopeById reports the row's partition, fenced to the agent.
    await expect(db.getScopeById("main", alphaEntry.id)).resolves.toBe("alpha");
    await expect(db.getScopeById("main", globalEntry.id)).resolves.toBe("");
    await expect(db.getScopeById("other-agent", alphaEntry.id)).resolves.toBeNull();

    // Operator inspection exposes the partition key: list carries scope per
    // row, query can select and filter on it, and stats reports the split.
    const listed = await db.list("main");
    expect(new Map(listed.map((entry) => [entry.id, entry.scope]))).toEqual(
      new Map([
        [globalEntry.id, ""],
        [alphaEntry.id, "alpha"],
      ]),
    );
    const scopedRows = await db.query("main", {
      columns: ["id", "scope"],
      filter: { column: "scope", operator: "=", value: "alpha" },
    });
    expect(scopedRows.map((row) => ({ id: row.id, scope: row.scope }))).toEqual([
      { id: alphaEntry.id, scope: "alpha" },
    ]);
    await expect(db.countScoped("main")).resolves.toBe(1);
    db.close();
  });
});
