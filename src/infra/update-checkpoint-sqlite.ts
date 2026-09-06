import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { INSTALLED_PLUGIN_INDEX_STATE_KEY } from "../plugins/installed-plugin-index-row.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-readonly-location.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import {
  checkpointPluginIndexMutationsMatch,
  type UpdateCheckpointPluginIndexMutation,
} from "./update-checkpoint-plugin-index.js";

/** Preserve the live SQLite family, including a closed WAL-mode source. */
export async function createUpdateCheckpointSqliteSnapshot(params: {
  sourcePath: string;
  targetPath: string;
  assertQuiescent: () => void;
}) {
  params.assertQuiescent();
  const prepared = await prepareSqliteReadOnlyLocation(params.sourcePath);
  try {
    params.assertQuiescent();
    return await createVerifiedSqliteSnapshot({
      sourcePath: prepared.location,
      targetPath: params.targetPath,
      preserveRowIds: true,
      requireNonEmptySource: true,
      beforePublish: params.assertQuiescent,
    });
  } finally {
    prepared.cleanup();
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
function schemaObjects(db: DatabaseSync): SchemaObject[] {
  return db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as SchemaObject[]; // SAFETY: sqlite_schema defines these four typed system columns.
}
function tableShape(objects: SchemaObject[], table: string): string {
  return JSON.stringify(objects.filter((entry) => entry.tbl_name === table));
}
type Row = Record<string, SQLOutputValue>;
function rowJson(row: Row): string;
function rowJson(row: Row | undefined): string | undefined;
function rowJson(row: Row | undefined): string | undefined {
  return JSON.stringify(row, (_key, value: unknown) => {
    if (typeof value === "bigint") {
      return { integer: value.toString() };
    }
    if (value instanceof Uint8Array) {
      return { blob: Buffer.from(value).toString("hex") };
    }
    return value;
  });
}
function rowIdentityColumn(db: DatabaseSync, table: string): string | null {
  if (
    db
      .prepare("PRAGMA table_list")
      .all()
      .some((row) => row.name === table && row.wr === 1)
  ) {
    return null;
  }
  const columns = db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all();
  const alias = ["rowid", "_rowid_", "oid"].find((name) =>
    columns.every((column) => String(column.name).toLowerCase() !== name),
  );
  if (!alias || columns.some((column) => column.name === "checkpoint_rowid")) {
    throw new UpdateCheckpointPreservationUnavailable(table);
  }
  return alias;
}
function readRows(db: DatabaseSync, table: string): Row[] {
  const rowid = rowIdentityColumn(db, table);
  // Dynamic schema names belong to this snapshot primitive, not runtime queries.
  const statement = db.prepare(
    `SELECT ${rowid ? `${rowid} AS checkpoint_rowid, ` : ""}* FROM ${quoteIdentifier(table)}`,
  );
  statement.setReadBigInts(true);
  return statement.all();
}
function rowsEqual(left: Row[], right: Row[]): boolean {
  const a = left.map((row) => rowJson(row)).toSorted(),
    b = right.map((row) => rowJson(row)).toSorted();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function rowsMatch(left: DatabaseSync, right: DatabaseSync, table: string): boolean {
  return rowsEqual(readRows(left, table), readRows(right, table));
}

/** Shape-compatible rows stay current; only the exactly bound plugin row may rewind. */
function mergeRows(
  checkpoint: DatabaseSync,
  afterUpdate: DatabaseSync,
  current: DatabaseSync,
  table: string,
): Row[] {
  const currentRows = readRows(current, table);
  if (table !== "config_machine_state") {
    return currentRows;
  }
  const isIndex = (row: Row) => row.state_key === INSTALLED_PLUGIN_INDEX_STATE_KEY;
  const before = readRows(checkpoint, table).find(isIndex);
  const after = readRows(afterUpdate, table).find(isIndex);
  if (rowJson(before) === rowJson(after)) {
    return currentRows;
  }
  const live = currentRows.find(isIndex);
  if (rowJson(live) === rowJson(before)) {
    return currentRows;
  }
  if (rowJson(live) !== rowJson(after)) {
    throw new UpdateCheckpointPreservationUnavailable(table);
  }
  return [...currentRows.filter((row) => !isIndex(row)), ...(before ? [before] : [])];
}

export class UpdateCheckpointPreservationUnavailable extends Error {
  constructor(readonly resource: string) {
    super(`Newer work cannot be preserved in the checkpoint schema: ${resource}`);
  }
}

/** Validate the exact old schema after all owner callbacks, before sealing. */
export function assertUpdateCheckpointSqliteSchema(
  checkpoint: DatabaseSync,
  staged: DatabaseSync,
): void {
  for (const pragma of ["user_version", "application_id", "encoding"]) {
    if (
      JSON.stringify(checkpoint.prepare(`PRAGMA ${pragma}`).get()) !==
      JSON.stringify(staged.prepare(`PRAGMA ${pragma}`).get())
    ) {
      throw new Error("Checkpoint SQLite schema identity mismatch");
    }
  }
  if (JSON.stringify(schemaObjects(checkpoint)) !== JSON.stringify(schemaObjects(staged))) {
    throw new Error("Checkpoint SQLite schema objects mismatch");
  }
  if (
    schemaObjects(checkpoint).some(
      (entry) => entry.type === "table" && entry.name === "schema_meta",
    ) &&
    !rowsMatch(checkpoint, staged, "schema_meta")
  ) {
    throw new Error("Checkpoint SQLite schema metadata mismatch");
  }
  assertSqliteIntegrity(staged, "restored checkpoint schema");
}

/** Keep virtual/shadow tables in a verified snapshot, never generic INSERT copies. */
export function selectUpdateCheckpointSqliteBase(params: {
  checkpoint: DatabaseSync;
  afterUpdate: DatabaseSync;
  current: DatabaseSync;
}): "checkpoint" | "current" {
  const before = schemaObjects(params.checkpoint);
  if (!before.some((entry) => /CREATE\s+VIRTUAL\s+TABLE/iu.test(entry.sql ?? ""))) {
    return "checkpoint";
  }
  if (
    JSON.stringify(before) !== JSON.stringify(schemaObjects(params.afterUpdate)) ||
    JSON.stringify(before) !== JSON.stringify(schemaObjects(params.current))
  ) {
    return "checkpoint";
  }
  return "current";
}

/**
 * Plan first, then carry CURRENT data into a checkpoint copy. Changed-schema tables
 * may rewind only when they still match the exact post-migration image. Shape-compatible
 * tables retain all current rows, including interval writes. Only the exact
 * plugin-index receipt chain binds a row reversal. Recovery rows have a separate owning carry-forward.
 * No schema version is invented and no live database is mutated here.
 */
export function carryForwardUpdateCheckpointSqlite(params: {
  checkpoint: DatabaseSync;
  afterUpdate: DatabaseSync;
  current: DatabaseSync;
  staged: DatabaseSync;
  databasePath?: string;
  pluginIndexMutations?: readonly UpdateCheckpointPluginIndexMutation[];
}): { preservedTables: string[]; restoredTables: string[] } {
  if (
    !checkpointPluginIndexMutationsMatch({
      mutations: params.pluginIndexMutations ?? [],
      databasePath: params.databasePath ?? "",
      checkpoint: params.checkpoint,
      afterUpdate: params.afterUpdate,
    })
  ) {
    throw new UpdateCheckpointPreservationUnavailable(
      params.databasePath ?? "config_machine_state",
    );
  }
  const previousObjects = schemaObjects(params.checkpoint);
  const afterObjects = schemaObjects(params.afterUpdate);
  const currentObjects = schemaObjects(params.current);
  const views = (objects: SchemaObject[]) =>
    objects.filter(
      (entry) =>
        entry.type === "view" ||
        (entry.type === "trigger" &&
          !objects.some((table) => table.type === "table" && table.name === entry.tbl_name)),
    );
  if (
    JSON.stringify(views(currentObjects)) !== JSON.stringify(views(afterObjects)) &&
    JSON.stringify(views(currentObjects)) !== JSON.stringify(views(previousObjects))
  ) {
    throw new UpdateCheckpointPreservationUnavailable("views");
  }
  const currentBase = selectUpdateCheckpointSqliteBase(params) === "current";
  const tables = (objects: SchemaObject[]) =>
    objects.filter((entry) => entry.type === "table").map((entry) => entry.name);
  const previousTables = tables(previousObjects),
    currentTables = tables(currentObjects);
  const preservedTables: string[] = [],
    restoredTables: string[] = [];
  const copyRows = new Map<string, Row[]>();
  for (const table of new Set([...previousTables, ...currentTables])) {
    if (table === "update_runs") {
      continue;
    }
    if (table === "schema_meta") {
      if (!rowsMatch(params.afterUpdate, params.current, table)) {
        throw new UpdateCheckpointPreservationUnavailable(table);
      }
      copyRows.set(table, readRows(params.checkpoint, table));
      restoredTables.push(table);
      continue;
    }
    const oldShape = tableShape(previousObjects, table),
      currentShape = tableShape(currentObjects, table);
    if (oldShape === currentShape && previousTables.includes(table)) {
      const definition =
        previousObjects.find((entry) => entry.type === "table" && entry.name === table)?.sql ?? "";
      // Virtual/shadow table mutation requires the extension owner. Equal contents
      // can remain untouched; changed contents cannot be copied with generic SQL.
      const virtual =
        /CREATE\s+VIRTUAL\s+TABLE/iu.test(definition) ||
        params.current
          .prepare("PRAGMA table_list")
          .all()
          .some((row) => row.name === table && row.type === "shadow");
      if (virtual) {
        if (
          currentBase
            ? !rowsMatch(params.current, params.staged, table)
            : !rowsMatch(params.checkpoint, params.current, table)
        ) {
          throw new UpdateCheckpointPreservationUnavailable(table);
        }
      } else {
        if (oldShape !== tableShape(afterObjects, table)) {
          throw new UpdateCheckpointPreservationUnavailable(table);
        }
        copyRows.set(
          table,
          mergeRows(params.checkpoint, params.afterUpdate, params.current, table),
        );
      }
      preservedTables.push(table);
    } else {
      const afterShape = tableShape(afterObjects, table);
      if (
        currentShape !== afterShape ||
        (currentTables.includes(table) && !rowsMatch(params.afterUpdate, params.current, table))
      ) {
        throw new UpdateCheckpointPreservationUnavailable(table);
      }
      restoredTables.push(table);
    }
  }
  // Triggers belong to the checkpoint schema, but must not run during data copy.
  // Foreign-key ordering is validated once the complete coherent state is installed.
  params.staged.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    const triggers = previousObjects.filter((entry) => entry.type === "trigger");
    for (const trigger of triggers) {
      params.staged.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
    }
    for (const [table, rows] of copyRows) {
      const columns = params.staged
        .prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
        .all()
        .filter((row) => row.hidden === 0)
        .map((row) => String(row.name));
      if (rowsEqual(rows, readRows(params.staged, table))) {
        continue;
      }
      const rowid = rowIdentityColumn(params.staged, table);
      const insertColumns = rowid ? [rowid, ...columns] : columns;
      params.staged.exec(`DELETE FROM ${quoteIdentifier(table)}`);
      const statement = params.staged.prepare(
        `INSERT INTO ${quoteIdentifier(table)} (${insertColumns.map(quoteIdentifier).join(",")}) VALUES (${insertColumns.map(() => "?").join(",")})`,
      );
      for (const row of rows) {
        statement.run(
          ...(rowid
            ? [row.checkpoint_rowid!, ...columns.map((column) => row[column]!)]
            : columns.map((column) => row[column]!)),
        );
      }
    }
    // AUTOINCREMENT must not reuse identities created and then deleted online.
    const hasSequence = (db: DatabaseSync) =>
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get();
    if (hasSequence(params.current) && hasSequence(params.staged)) {
      const sequence = (db: DatabaseSync, name: string) => {
        if (!hasSequence(db)) {
          return 0n;
        }
        const statement = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?");
        statement.setReadBigInts(true);
        const value = statement.get(name)?.seq ?? 0n;
        if (typeof value !== "bigint") {
          throw new UpdateCheckpointPreservationUnavailable("sqlite_sequence");
        }
        return value;
      };
      for (const table of preservedTables) {
        const previous = sequence(params.checkpoint, table),
          current = sequence(params.current, table),
          staged = sequence(params.staged, table);
        // Undo mutation-owned lowering, retain the online high-water mark and
        // every identity represented by preserved current rows.
        const chosen = current > previous ? current : previous;
        const seq = chosen > staged ? chosen : staged;
        if (seq > 0n) {
          params.staged.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
          params.staged
            .prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)")
            .run(table, seq);
        }
      }
    }
    for (const trigger of triggers) {
      if (trigger.sql) {
        params.staged.exec(trigger.sql);
      }
    }
    const version = Number(params.checkpoint.prepare("PRAGMA user_version").get()?.user_version);
    params.staged.exec(`PRAGMA user_version = ${version}`);
    assertUpdateCheckpointSqliteSchema(params.checkpoint, params.staged);
    params.staged.exec("COMMIT");
  } catch (error) {
    params.staged.exec("ROLLBACK");
    throw error;
  }
  for (const table of preservedTables) {
    if (
      !rowsEqual(
        copyRows.get(table) ?? readRows(params.current, table),
        readRows(params.staged, table),
      )
    ) {
      throw new UpdateCheckpointPreservationUnavailable(table);
    }
  }
  return { preservedTables, restoredTables };
}
