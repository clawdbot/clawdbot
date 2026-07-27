// Shared state database recovery tests cover eviction of a corruption-poisoned cached handle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSqliteCorruptionError } from "../infra/sqlite-transaction.js";
import {
  closeOpenClawStateDatabaseForTest,
  getOpenClawStateDatabaseIfOpen,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

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
});

describe("shared state write transaction corruption recovery", () => {
  it("evicts the cached handle so a healthy file reopens without a process restart", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const poisoned = openOpenClawStateDatabase({ env });
    expect(getOpenClawStateDatabaseIfOpen({ env })).toBe(poisoned);

    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          throw sqliteError("file is not a database", 26);
        },
        { env },
      ),
    ).toThrow(/file is not a database/u);

    expect(getOpenClawStateDatabaseIfOpen({ env })).toBeUndefined();
    const reopened = openOpenClawStateDatabase({ env });
    expect(reopened).not.toBe(poisoned);
    expect(reopened.db.isOpen).toBe(true);
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
