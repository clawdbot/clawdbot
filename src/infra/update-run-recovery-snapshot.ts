import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

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
export function digestUpdateRecoveryDatabase(db: DatabaseSync, runId: string): string {
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
      if (name === "config_machine_state" && row.state_key === `update.recovery.${runId}`) {
        continue;
      }
      rows.push(createHash("sha256").update(serializeRow(row)).digest("hex"));
    }
    hash.update(JSON.stringify([name, rows.toSorted()]));
  }
  return hash.digest("hex");
}
