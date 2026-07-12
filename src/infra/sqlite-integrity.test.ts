import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";

describe("assertSqliteIntegrity", () => {
  it("accepts structurally and referentially consistent databases", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO parents (id) VALUES (1);
        INSERT INTO children (id, parent_id) VALUES (1, 1);
      `);

      expect(assertSqliteIntegrity(database, "test database")).toEqual({
        integrityCheck: "ok",
        quickCheck: "ok",
      });
    } finally {
      database.close();
    }
  });

  it("rejects foreign-key violations that structural checks do not detect", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id) VALUES (1, 99);
      `);
      expect(database.prepare("PRAGMA quick_check;").get()).toEqual({ quick_check: "ok" });
      expect(database.prepare("PRAGMA integrity_check;").get()).toEqual({
        integrity_check: "ok",
      });

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /foreign_key_check failed for test database: children row 1 references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });

  it("reports violations deterministically without truncating 64-bit rowids", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id)
        VALUES (9007199254740993, 99), (1, 99);
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /children row 1 references parents \(foreign key 0\); children row 9007199254740993 references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });

  it("bounds foreign-key violation diagnostics", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id)
        VALUES (1, 99), (2, 99), (3, 99), (4, 99), (5, 99), (6, 99);
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /children row 5 references parents \(foreign key 0\); additional violations omitted$/u,
      );
    } finally {
      database.close();
    }
  });

  it("cannot be bypassed by a schema object shadowing the table-valued pragma", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id) VALUES (1, 99);
        CREATE TABLE pragma_foreign_key_check (
          "table" TEXT NOT NULL,
          rowid INTEGER,
          parent TEXT NOT NULL,
          fkid INTEGER NOT NULL
        );
      `);
      expect(
        database.prepare('SELECT "table", rowid, parent, fkid FROM pragma_foreign_key_check').all(),
      ).toEqual([]);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /foreign_key_check failed for test database: children row 1 references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });

  it("identifies violations in WITHOUT ROWID tables", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id TEXT PRIMARY KEY);
        CREATE TABLE children (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parents(id)
        ) WITHOUT ROWID;
        INSERT INTO children (id, parent_id) VALUES ('child-1', 'missing-parent');
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /foreign_key_check failed for test database: children row without rowid references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });
});
