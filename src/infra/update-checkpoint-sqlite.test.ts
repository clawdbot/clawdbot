import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { carryForwardUpdateCheckpointSqlite } from "./update-checkpoint-sqlite.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});
function database(sql: string) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(sql);
  return db;
}
const before = `
  CREATE TABLE schema_meta (schema_version INTEGER); INSERT INTO schema_meta VALUES (1);
  CREATE TABLE work (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT);
  INSERT INTO work VALUES (1, 'checkpoint turn');
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO settings VALUES ('migrated', 'before');
  CREATE TABLE update_runs (id TEXT PRIMARY KEY, outcome TEXT);
  INSERT INTO update_runs VALUES ('old', 'ok');
`;
function fixture() {
  const checkpoint = database(before),
    staged = database(before),
    afterUpdate = database(before),
    current = database(before);
  for (const db of [afterUpdate, current]) {
    db.exec(
      "ALTER TABLE settings ADD COLUMN migration TEXT; UPDATE settings SET value = 'after', migration = 'done'; UPDATE schema_meta SET schema_version = 2",
    );
  }
  return { checkpoint, staged, afterUpdate, current };
}

describe("checkpoint database preservation", () => {
  it("preserves quoted identifiers, full-width integers and blobs without trusting pragma shadows", () => {
    const sql = `CREATE TABLE "work.""quoted" (rowid TEXT, "value.""column" INTEGER, bytes BLOB);
      CREATE TABLE "without.rowid" (key TEXT PRIMARY KEY, value INTEGER) WITHOUT ROWID;
      CREATE TABLE pragma_table_list (name TEXT, wr INTEGER);
      INSERT INTO pragma_table_list VALUES ('work."quoted', 1);`;
    const checkpoint = database(sql),
      staged = database(sql),
      afterUpdate = database(sql),
      current = database(sql);
    current.exec(`INSERT INTO "work.""quoted" (_rowid_, rowid, "value.""column", bytes)
      VALUES (9007199254740997, 'declared rowid', 9223372036854775806, X'00ff807f');
      INSERT INTO "without.rowid" VALUES ('key', 9223372036854775805);`);
    carryForwardUpdateCheckpointSqlite({ checkpoint, staged, afterUpdate, current });
    const rows = staged.prepare('SELECT _rowid_ AS identity, * FROM "work.""quoted"');
    rows.setReadBigInts(true);
    expect(rows.all()).toEqual([
      {
        identity: 9007199254740997n,
        rowid: "declared rowid",
        'value."column': 9223372036854775806n,
        bytes: new Uint8Array([0, 255, 128, 127]),
      },
    ]);
    const keyed = staged.prepare('SELECT * FROM "without.rowid"');
    keyed.setReadBigInts(true);
    expect(keyed.all()).toEqual([{ key: "key", value: 9223372036854775805n }]);
  });

  it("retains a searchable online turn in the canonical agent FTS schema", () => {
    const checkpoint = database(OPENCLAW_AGENT_SCHEMA_SQL),
      afterUpdate = database(OPENCLAW_AGENT_SCHEMA_SQL),
      current = database(OPENCLAW_AGENT_SCHEMA_SQL),
      staged = database(OPENCLAW_AGENT_SCHEMA_SQL);
    for (const db of [afterUpdate, current, staged]) {
      db.exec(
        "INSERT INTO session_transcript_fts(rowid, text, session_id, message_id, role, timestamp) VALUES(42, 'verification zebra', 'session', 'turn', 'assistant', 1)",
      );
    }
    carryForwardUpdateCheckpointSqlite({ checkpoint, afterUpdate, current, staged });
    expect(
      staged
        .prepare(
          "SELECT rowid, message_id FROM session_transcript_fts WHERE session_transcript_fts MATCH 'zebra'",
        )
        .all(),
    ).toEqual([{ rowid: 42, message_id: "turn" }]);
  });

  it.each(["CREATE VIEW operator_view AS SELECT * FROM work", "DROP VIEW existing_view"])(
    "refuses newer view work: %s",
    (change) => {
      const input = fixture();
      for (const db of Object.values(input)) {
        db.exec("CREATE VIEW existing_view AS SELECT * FROM work");
      }
      input.current.exec(change);
      expect(() => carryForwardUpdateCheckpointSqlite(input)).toThrow(
        /Newer work cannot be preserved/u,
      );
    },
  );

  it.each([100n, 9007199254740999n])(
    "undoes lowered sequences without reusing deleted identity %s",
    (highWater) => {
      const checkpoint = database(before),
        staged = database(before),
        afterUpdate = database(before),
        current = database(before);
      for (const db of [checkpoint, staged]) {
        db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='work'").run(highWater);
      }
      carryForwardUpdateCheckpointSqlite({ checkpoint, staged, afterUpdate, current });
      const insert = staged.prepare("INSERT INTO work(text) VALUES('next')");
      insert.setReadBigInts(true);
      expect(insert.run().lastInsertRowid).toBe(highWater + 1n);
    },
  );

  it("preserves shape-compatible interval and later work without inferring mutation ownership", () => {
    const checkpoint = database(before),
      staged = database(before),
      afterUpdate = database(before),
      current = database(before);
    afterUpdate.exec("UPDATE settings SET value='interval work' WHERE key='migrated'");
    current.exec(
      "UPDATE settings SET value='interval work' WHERE key='migrated'; INSERT INTO settings VALUES('online', 'operator work')",
    );
    carryForwardUpdateCheckpointSqlite({ checkpoint, staged, afterUpdate, current });
    expect(staged.prepare("SELECT * FROM settings ORDER BY key").all()).toEqual([
      { key: "migrated", value: "interval work" },
      { key: "online", value: "operator work" },
    ]);
  });

  it("restores migrated settings while retaining online turns, edits, deletes, and non-reused identities", () => {
    const input = fixture();
    input.current.exec(
      "UPDATE work SET text = 'edited online' WHERE id = 1; INSERT INTO work(text) VALUES ('verification turn'); INSERT INTO work(text) VALUES ('deleted online'); DELETE FROM work WHERE id = 3",
    );
    const result = carryForwardUpdateCheckpointSqlite(input);
    expect(result.restoredTables).toContain("settings");
    expect(input.staged.prepare("SELECT * FROM settings").all()).toEqual([
      { key: "migrated", value: "before" },
    ]);
    expect(input.staged.prepare("SELECT * FROM work").all()).toEqual([
      { id: 1, text: "edited online" },
      { id: 2, text: "verification turn" },
    ]);
    expect(
      input.staged.prepare("INSERT INTO work(text) VALUES ('next')").run().lastInsertRowid,
    ).toBe(4);
    expect(input.staged.prepare("SELECT * FROM schema_meta").get()).toEqual({ schema_version: 1 });
  });

  it("refuses to overwrite work in a schema that cannot represent it, before touching staging", () => {
    const input = fixture();
    input.current.exec("INSERT INTO settings VALUES ('operator', 'new', 'online')");
    expect(() => carryForwardUpdateCheckpointSqlite(input)).toThrow(
      /Newer work cannot be preserved/u,
    );
    expect(input.staged.prepare("SELECT * FROM settings").all()).toEqual([
      { key: "migrated", value: "before" },
    ]);
  });

  it("preserves deletion and cross-table foreign keys without replaying triggers", () => {
    const sql = `CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parent(id)); CREATE TABLE audit (id INTEGER); CREATE TRIGGER insertion AFTER INSERT ON parent BEGIN INSERT INTO audit VALUES(new.id); END; INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1, 1);`;
    const checkpoint = database(sql),
      staged = database(sql),
      afterUpdate = database(sql),
      current = database(sql);
    current.exec(
      "DELETE FROM child; DELETE FROM parent; INSERT INTO parent VALUES(2); INSERT INTO child VALUES(2, 2)",
    );
    carryForwardUpdateCheckpointSqlite({ checkpoint, staged, afterUpdate, current });
    expect(staged.prepare("SELECT * FROM audit").all()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(staged.prepare("SELECT * FROM child").all()).toEqual([{ id: 2, parent: 2 }]);
  });
});
