import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import {
  encodeUpdateRecovery,
  UpdateRecoveryConflictError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import { requireRevision } from "./update-run-recovery-store.js";
import type { UpdateRecoveryDatabaseBinding } from "./update-run-recovery-types.js";

/** Path spelling does not distinguish a disposable copy from a hard-linked live DB. */
export function assertSeparateUpdateRecoveryDatabases(
  sourceDb: DatabaseSync,
  stagedDb: DatabaseSync,
): void {
  const message = "Recovery carry-forward requires separate idle source and staged databases";
  if (sourceDb === stagedDb || sourceDb.isTransaction || stagedDb.isTransaction) {
    throw new Error(message);
  }
  const sourcePath = sourceDb.location();
  const stagedPath = stagedDb.location();
  if (sourcePath !== null && stagedPath !== null) {
    // stat follows symbolic links; device + inode also detects distinct hard-link paths.
    // Use bigint to avoid rounding large file identifiers into false matches.
    const source = statSync(sourcePath, { bigint: true });
    const stage = statSync(stagedPath, { bigint: true });
    if (source.dev === stage.dev && source.ino === stage.ino) {
      throw new Error(message);
    }
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
function serializeRow(row: Record<string, SQLOutputValue>): string {
  return JSON.stringify(
    Object.keys(row)
      .toSorted()
      .map((key) => {
        const value = row[key];
        return [
          key,
          value instanceof Uint8Array
            ? ["blob", Buffer.from(value).toString("hex")]
            : [typeof value, typeof value === "bigint" ? value.toString() : value],
        ];
      }),
  );
}

/**
 * SQLite snapshot primitive, not a runtime query. Bind every schema object and
 * logical row (including rowids, sequences, history and other recovery records).
 * The caller separately validates the one active operational row in full. Page
 * layout is deliberately not identity: an authorized progress write changes it.
 */
function digestUpdateRecoveryDatabase(db: DatabaseSync, runId: string): string {
  const hash = createHash("sha256");
  const schema = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all();
  for (const pragma of ["user_version", "application_id", "encoding"]) {
    hash.update(JSON.stringify([pragma, db.prepare(`PRAGMA ${pragma}`).get()]));
  }
  hash.update(JSON.stringify(schema));
  const tableList = db.prepare("PRAGMA table_list").all();
  for (const table of schema.filter((entry) => entry.type === "table")) {
    const name = String(table.name);
    const columns = db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`).all();
    const withoutRowid = tableList.some((entry) => entry.name === name && entry.wr === 1);
    const rowid = ["rowid", "_rowid_", "oid"].find((candidate) =>
      columns.every((column) => String(column.name).toLowerCase() !== candidate),
    );
    if (!withoutRowid && !rowid) {
      throw new Error("Cannot bind a checkpoint table with inaccessible row identity");
    }
    if (columns.some((column) => column.name === "__update_rowid")) {
      throw new Error("Cannot bind a checkpoint table with ambiguous row identity");
    }
    const statement = db.prepare(
      `SELECT ${withoutRowid ? "" : `${rowid} AS ${quoteIdentifier("__update_rowid")}, `}* FROM ${quoteIdentifier(name)}`,
    );
    statement.setReadBigInts(true);
    const rows: string[] = [];
    for (const row of statement.iterate()) {
      if (name === "config_machine_state" && row.state_key === UPDATE_RECOVERY_KEY_PREFIX + runId) {
        continue;
      }
      rows.push(createHash("sha256").update(serializeRow(row)).digest("hex"));
    }
    hash.update(JSON.stringify([name, rows.toSorted()]));
  }
  return hash.digest("hex");
}

export function assertExactRecovery(db: DatabaseSync, expected: UpdateRecoveryRecord): void {
  const { raw } = requireRevision(db, expected);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<DB, "config_machine_state">>(db)
      .selectFrom("config_machine_state")
      .select("updated_at_ms")
      .where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + expected.runId),
  );
  if (raw !== encodeUpdateRecovery(expected) || row?.updated_at_ms !== expected.updatedAtMs) {
    throw new UpdateRecoveryConflictError();
  }
}

/**
 * Read-only snapshot; use an artifact-preserving handle BEFORE claim/admission.
 * No schema migration, WAL setup, cleanup, or general runtime open occurs here.
 * Every other row is bound, including all history and unrelated machine state.
 */
export function readUpdateRecoveryDatabaseBinding(
  db: DatabaseSync,
  expected: UpdateRecoveryRecord,
): UpdateRecoveryDatabaseBinding {
  const ownsRead = !db.isTransaction;
  if (ownsRead) {
    db.exec("BEGIN"); // sqlite-allow-raw -- One consistent read-only snapshot.
  }
  try {
    assertExactRecovery(db, expected);
    assertSqliteIntegrity(db, "update recovery database binding");
    return {
      runId: expected.runId,
      transactionId: expected.transactionId,
      sha256: digestUpdateRecoveryDatabase(db, expected.runId),
    };
  } finally {
    if (ownsRead) {
      db.exec("ROLLBACK"); // sqlite-allow-raw -- Close read snapshot without writes.
    }
  }
}
