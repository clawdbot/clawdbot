// Shared state database recovery tests cover eviction of a corruption-poisoned cached handle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { isSqliteCorruptionError } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  getOpenClawStateDatabaseIfOpen,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

type StateDbTestDatabase = Pick<OpenClawStateKyselyDatabase, "diagnostic_events">;

const PROBE_SCOPE = "corruption-recovery-test";
// Real out-of-place b-tree leaf page from the production incident: page 1 no
// longer carries the SQLite header, so any reader that rereads it reports NOTADB.
const CORRUPT_PAGE_HEADER = Uint8Array.from([0x0a, 0x04, 0xc7, 0x00, 0xcb, 0x01, 0xb9, 0x00]);
const SQLITE_PAGE_SIZE = 4096;

const tempStateDirs: string[] = [];

function createTempStateDir(): string {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-db-corruption-")),
  );
  tempStateDirs.push(stateDir);
  return stateDir;
}

function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), { errcode });
}

function corruptPageOne(databasePath: string): void {
  const page = Buffer.alloc(SQLITE_PAGE_SIZE);
  page.set(CORRUPT_PAGE_HEADER, 0);
  const handle = fs.openSync(databasePath, "r+");
  try {
    fs.writeSync(handle, page, 0, page.length, 0);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  // The cached handle can still serve page 1 from the WAL, so the sidecars must
  // go too or the corrupted main file is never read.
  fs.rmSync(`${databasePath}-wal`, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
}

function insertProbeEvent(env: NodeJS.ProcessEnv, eventKey: string): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        stateDb.insertInto("diagnostic_events").values({
          scope: PROBE_SCOPE,
          event_key: eventKey,
          payload_json: "{}",
          created_at: 1,
        }),
      );
    },
    { env },
  );
}

function readProbeEventKeys(database: { db: DatabaseSync }): string[] {
  const stateDb = getNodeSqliteKysely<StateDbTestDatabase>(database.db);
  const { rows } = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("diagnostic_events")
      .select("event_key")
      .where("scope", "=", PROBE_SCOPE)
      .orderBy("event_key"),
  );
  return rows.map((row) => row.event_key);
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const stateDir of tempStateDirs.splice(0)) {
    fs.rmSync(stateDir, { force: true, recursive: true });
  }
});

describe("isSqliteCorruptionError", () => {
  const cases: Array<{ error: unknown; expected: boolean; name: string }> = [
    { error: sqliteError("file is not a database", 26), expected: true, name: "NOTADB" },
    { error: sqliteError("database disk image is malformed", 11), expected: true, name: "CORRUPT" },
    { error: sqliteError("corrupt index", 779), expected: true, name: "extended CORRUPT" },
    { error: sqliteError("database is locked", 5), expected: false, name: "BUSY" },
    { error: sqliteError("database table is locked", 6), expected: false, name: "LOCKED" },
    { error: new Error("plain failure"), expected: false, name: "no errcode" },
  ];

  for (const testCase of cases) {
    it(`returns ${String(testCase.expected)} for ${testCase.name}`, () => {
      expect(isSqliteCorruptionError(testCase.error)).toBe(testCase.expected);
    });
  }

  it("classifies the error the real node:sqlite driver throws on a corrupt file", () => {
    const databasePath = path.join(createTempStateDir(), "garbage.sqlite");
    const page = Buffer.alloc(SQLITE_PAGE_SIZE);
    page.set(CORRUPT_PAGE_HEADER, 0);
    fs.writeFileSync(databasePath, page);

    const { DatabaseSync } = requireNodeSqlite();
    const raw = new DatabaseSync(databasePath);
    let thrown: unknown;
    try {
      raw.prepare("SELECT count(*) AS total FROM sqlite_master").get();
    } catch (error) {
      thrown = error;
    } finally {
      raw.close();
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("file is not a database");
    expect(thrown).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 26 });
    expect(isSqliteCorruptionError(thrown)).toBe(true);
  });
});

describe("shared state write transaction corruption recovery", () => {
  it("evicts the cached handle so a repaired file recovers without a process restart", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const poisoned = openOpenClawStateDatabase({ env });
    const databasePath = poisoned.path;
    insertProbeEvent(env, "before-corruption");
    expect(readProbeEventKeys(poisoned)).toEqual(["before-corruption"]);

    // A second connection bumps SQLite's change counter and folds the WAL back
    // into the main file, so the cached handle must reread page 1 and the
    // healthy snapshot below is byte-complete.
    const { DatabaseSync } = requireNodeSqlite();
    const second = new DatabaseSync(databasePath);
    try {
      second.exec(
        `INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at)
         VALUES ('${PROBE_SCOPE}', 'second-connection', '{}', 2)`,
      );
      second.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      second.close();
    }
    const healthySnapshot = fs.readFileSync(databasePath);

    corruptPageOne(databasePath);

    let thrown: unknown;
    try {
      insertProbeEvent(env, "during-corruption");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("file is not a database");
    expect(thrown).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 26 });
    expect(getOpenClawStateDatabaseIfOpen({ env })).toBeUndefined();

    fs.writeFileSync(databasePath, healthySnapshot);

    const reopened = openOpenClawStateDatabase({ env });
    expect(reopened).not.toBe(poisoned);
    expect(reopened.db.isOpen).toBe(true);
    expect(readProbeEventKeys(reopened)).toEqual(["before-corruption", "second-connection"]);
  });

  it("keeps the cached handle when a write fails without proven corruption", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const cached = openOpenClawStateDatabase({ env });

    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          throw sqliteError("database is locked", 5);
        },
        { env },
      ),
    ).toThrow(/database is locked/u);

    expect(getOpenClawStateDatabaseIfOpen({ env })).toBe(cached);
  });
});
