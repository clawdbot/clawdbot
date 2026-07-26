import fs from "node:fs/promises";
import path from "node:path";
import type { Insertable, Selectable } from "kysely";
import { stableStringify } from "../agents/stable-stringify.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";

const DATABASE_FILENAME = "recovery-journal.sqlite";
const PRIVATE_FILE_MODE = 0o600;

type RecoveryJournalRecordTable = {
  record_type: string;
  payload_json: string;
};

type RecoveryJournalDatabase = {
  recovery_journal_records: RecoveryJournalRecordTable;
};

class RecoveryJournalError extends Error {
  constructor(
    public readonly kind: "conflict" | "corrupt",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecoveryJournalError";
  }
}

export function resolveRecoveryJournalPath(directoryPath: string): string {
  return path.join(directoryPath, DATABASE_FILENAME);
}

export async function readRecoveryJournalRecord(
  databasePath: string,
  recordType: string,
): Promise<unknown> {
  const database = await openRecoveryJournal(databasePath);
  try {
    const kysely = getNodeSqliteKysely<RecoveryJournalDatabase>(database);
    const row = executeSqliteQuerySync(
      database,
      kysely
        .selectFrom("recovery_journal_records")
        .select(["record_type", "payload_json"])
        .where("record_type", "=", recordType),
    ).rows[0] as Selectable<RecoveryJournalRecordTable> | undefined;
    if (!row) {
      return undefined;
    }
    try {
      return JSON.parse(row.payload_json) as unknown;
    } catch (error) {
      throw new RecoveryJournalError(
        "corrupt",
        `Recovery journal record is not valid JSON: ${recordType}.`,
        { cause: error },
      );
    }
  } finally {
    database.close();
  }
}

export async function writeRecoveryJournalRecord(
  databasePath: string,
  recordType: string,
  value: unknown,
): Promise<void> {
  const database = await openRecoveryJournal(databasePath);
  try {
    const kysely = getNodeSqliteKysely<RecoveryJournalDatabase>(database);
    const record: Insertable<RecoveryJournalRecordTable> = {
      record_type: recordType,
      payload_json: stableStringify(value),
    };
    const written = executeSqliteQuerySync(
      database,
      kysely
        .insertInto("recovery_journal_records")
        .values(record)
        .onConflict((conflict) => conflict.column("record_type").doNothing()),
    );
    if (written.numAffectedRows !== 1n) {
      throw new RecoveryJournalError(
        "conflict",
        `Recovery journal record already exists: ${recordType}.`,
      );
    }
  } finally {
    database.close();
  }
}

async function openRecoveryJournal(databasePath: string) {
  const existed = await fs
    .lstat(databasePath)
    .then((stat) => {
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw new RecoveryJournalError("corrupt", "Recovery journal is not a trusted file.");
      }
      return true;
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    });
  const database = openNodeSqliteDatabase(databasePath);
  try {
    // sqlite-allow-raw -- this boundary owns dedicated journal bootstrap DDL and durability pragmas.
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS recovery_journal_records (
        record_type TEXT PRIMARY KEY NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
    `);
    applyPrivateModeSync(databasePath, PRIVATE_FILE_MODE);
    if (!existed) {
      requireDirectorySync(await syncDirectory(path.dirname(databasePath)), "Recovery journal");
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
