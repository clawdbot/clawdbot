import { describe, expect, test } from "vitest";
import { MemoryDB } from "./lancedb-store.js";
import { installTmpDirHarness } from "./test-helpers.js";

describe("MemoryDB observes externally committed rows", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-staleness-" });

  test("a reader opened before an external write still sees that write", async () => {
    const dbPath = getDbPath();
    const reader = new MemoryDB(dbPath, 2);
    const writer = new MemoryDB(dbPath, 2);

    try {
      // Force the reader to open the table, pinning its Lance version.
      await expect(reader.search("alpha", [1, 0], 5, 0)).resolves.toEqual([]);

      // A different store commits to the same directory. In production this is a
      // separate ingest process; the failure mode is identical either way.
      const external = await writer.store("alpha", {
        text: "committed by another writer",
        vector: [1, 0],
        importance: 0.5,
        category: "other",
      });

      // Without checkoutLatest() the reader stays on the version it opened and
      // returns nothing here, so recall cannot see anything a separate writer
      // ingested for as long as the process lives.
      await expect(reader.search("alpha", [1, 0], 5, 0)).resolves.toMatchObject([
        { entry: { id: external.id, text: "committed by another writer" } },
      ]);
      await expect(reader.count("alpha")).resolves.toBe(1);
      await expect(reader.list("alpha", 5)).resolves.toMatchObject([{ id: external.id }]);
    } finally {
      reader.close();
      writer.close();
    }
  });

  test("refreshing the version does not widen agent scope", async () => {
    // Control. The fix advances which VERSION is read, and must not change WHICH
    // ROWS an agent may read -- a refresh that also leaked another agent's
    // memories would satisfy the test above while breaking isolation.
    const dbPath = getDbPath();
    const reader = new MemoryDB(dbPath, 2);
    const writer = new MemoryDB(dbPath, 2);

    try {
      await expect(reader.search("alpha", [1, 0], 5, 0)).resolves.toEqual([]);
      await writer.store("beta", {
        text: "beta private preference",
        vector: [1, 0],
        importance: 0.9,
        category: "preference",
      });

      await expect(reader.search("alpha", [1, 0], 5, 0)).resolves.toEqual([]);
      await expect(reader.count("alpha")).resolves.toBe(0);
      await expect(reader.count("beta")).resolves.toBe(1);
    } finally {
      reader.close();
      writer.close();
    }
  });
});
