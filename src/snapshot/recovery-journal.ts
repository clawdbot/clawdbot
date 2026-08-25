import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import type { Insertable } from "kysely";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { isErrno } from "../infra/errno.js";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
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
  const { database } = await openRecoveryJournal(databasePath);
  try {
    const kysely = getNodeSqliteKysely<RecoveryJournalDatabase>(database);
    const row = executeSqliteQuerySync(
      database,
      kysely
        .selectFrom("recovery_journal_records")
        .select(["record_type", "payload_json"])
        .where("record_type", "=", recordType),
    ).rows[0];
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
  const { database, expectedIdentity } = await openRecoveryJournal(databasePath);
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
    await assertRecoveryJournalIdentity(databasePath, expectedIdentity, "during record commit");
    requireDirectorySync(await syncDirectory(path.dirname(databasePath)), "Recovery journal");
    await assertRecoveryJournalIdentity(databasePath, expectedIdentity, "during record commit");
  } finally {
    database.close();
  }
}

async function openRecoveryJournal(databasePath: string) {
  const expectedIdentity =
    (await readTrustedRecoveryJournalIdentity(databasePath)) ??
    (await createTrustedRecoveryJournalFile(databasePath));
  const database = openNodeSqliteDatabase(databasePath);
  try {
    const openedIdentity = await readTrustedRecoveryJournalIdentity(databasePath);
    if (!openedIdentity || !sameFileIdentity(expectedIdentity, openedIdentity)) {
      throw new RecoveryJournalError(
        "corrupt",
        "Recovery journal identity changed before SQLite ownership was established.",
      );
    }
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
    requireDirectorySync(await syncDirectory(path.dirname(databasePath)), "Recovery journal");
    return { database, expectedIdentity };
  } catch (error) {
    database.close();
    throw error;
  }
}

async function readTrustedRecoveryJournalIdentity(databasePath: string) {
  return await fs
    .lstat(databasePath)
    .then((stat) => {
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw new RecoveryJournalError("corrupt", "Recovery journal is not a trusted file.");
      }
      return stat;
    })
    .catch((error: unknown) => {
      if (isErrno(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
}

async function createTrustedRecoveryJournalFile(databasePath: string) {
  const handle = await fs.open(databasePath, "wx", PRIVATE_FILE_MODE);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new RecoveryJournalError("corrupt", "Recovery journal is not a trusted file.");
    }
    await handle.sync();
    return stat;
  } finally {
    await handle.close();
  }
}

async function assertRecoveryJournalIdentity(
  databasePath: string,
  expectedIdentity: Awaited<ReturnType<typeof createTrustedRecoveryJournalFile>>,
  phase: string,
): Promise<void> {
  const currentIdentity = await readTrustedRecoveryJournalIdentity(databasePath);
  if (!currentIdentity || !sameFileIdentity(expectedIdentity, currentIdentity)) {
    throw new RecoveryJournalError("corrupt", `Recovery journal identity changed ${phase}.`);
  }
}
