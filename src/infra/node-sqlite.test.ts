// Covers the SQLite WAL-reset corruption safety floor.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalPrepare = Reflect.get(DatabaseSync.prototype, "prepare") as DatabaseSync["prepare"];

async function loadNodeSqliteWithVersion(version: string) {
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
    function (this: DatabaseSync, sql) {
      if (sql === "SELECT sqlite_version() AS version") {
        return {
          get: () => ({ version }),
        } as unknown as StatementSync;
      }
      return originalPrepare.call(this, sql);
    },
  );
  return await import("./node-sqlite.js");
}

describe("node SQLite safety", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["3.51.3", "3.51.4", "3.52.0", "4.0.0", "3.50.7", "3.50.8", "3.44.6"])(
    "accepts patched SQLite %s",
    async (version) => {
      const { requireNodeSqlite } = await loadNodeSqliteWithVersion(version);
      expect(() => requireNodeSqlite()).not.toThrow();
    },
  );

  it.each(["3.51.2", "3.51.0", "3.50.6", "3.49.1", "3.44.5", "invalid", "3.51"])(
    "rejects vulnerable or unknown SQLite %s",
    async (version) => {
      const { requireNodeSqlite } = await loadNodeSqliteWithVersion(version);
      expect(() => requireNodeSqlite()).toThrow(`embeds SQLite ${version}, which is affected`);
    },
  );

  it("accepts the SQLite build embedded in the supported test runtime", () => {
    return import("./node-sqlite.js").then(({ requireNodeSqlite }) => {
      expect(() => requireNodeSqlite()).not.toThrow();
    });
  });
});
