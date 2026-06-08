// Session store read tests cover read-only SQLite-backed session snapshots.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { readSessionStoreReadOnly } from "./store-read.js";
import { resolveSqliteSessionStoreDatabasePath } from "./store-sqlite.js";
import { saveSessionStore } from "./store.js";

describe("readSessionStoreReadOnly", () => {
  it("returns an empty store when no SQLite session rows exist", async () => {
    await withTempDir({ prefix: "openclaw-session-store-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = resolveSqliteSessionStoreDatabasePath(storePath);

      expect(readSessionStoreReadOnly(storePath)).toStrictEqual({});
      expect(fs.existsSync(databasePath)).toBe(false);
    });
  });

  it("returns normalized session store snapshots", async () => {
    await withTempDir({ prefix: "openclaw-session-store-readonly-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      await saveSessionStore(
        storePath,
        {
          good: { sessionId: " good-session ", updatedAt: Number.NaN },
          badId: { sessionId: "../etc/passwd", updatedAt: 1 },
        },
        { skipMaintenance: true },
      );

      const store = readSessionStoreReadOnly(storePath);

      expect(store.good?.sessionId).toBe("good-session");
      expect(store.good?.updatedAt).toBe(0);
      expect(store.badId).toBeUndefined();
    });
  });

  it("returns an empty store when the SQLite file is unreadable", async () => {
    await withTempDir({ prefix: "openclaw-session-store-corrupt-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = resolveSqliteSessionStoreDatabasePath(storePath);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.writeFileSync(databasePath, "not sqlite");

      expect(readSessionStoreReadOnly(storePath)).toStrictEqual({});

      const sqlite = requireNodeSqlite();
      const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(() => database.prepare("SELECT name FROM sqlite_master")).toThrow();
      } finally {
        database.close();
      }
    });
  });
});
