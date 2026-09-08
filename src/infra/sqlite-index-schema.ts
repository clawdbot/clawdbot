import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteIntegrity,
  assertSqliteTableIntegrity,
  isTerminalSqliteIntegrityError,
  runSqliteIntegrityOperationSync,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "./sqlite-integrity.js";
import {
  collectSqliteNamedIndexContract,
  getCanonicalSqliteNamedIndexContracts,
  getCanonicalSqliteTableNames,
  type CanonicalSqliteNamedIndexContract,
} from "./sqlite-schema-contract.js";

const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type SqliteIndexListRow = {
  name: string;
  origin: string;
  unique: number;
};

type RepairCanonicalSqliteIndexesOptions = {
  /**
   * A recognized schema migration may add a column before recreating its
   * canonical index. No other repair failure is deferred.
   */
  allowMissingColumns?: boolean;
  /** Keep index repair atomic with the caller's whole-schema validation. */
  validateAfterRepair?: () => void;
  verifyPhysicalIntegrity?: boolean;
};

/**
 * Verify the whole file once, then use table scans only to locate repairable
 * index damage. Healthy opens must not multiply integrity work by table count.
 */
export function verifyAndRepairCanonicalSqliteIndexes(
  db: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  options: Omit<RepairCanonicalSqliteIndexesOptions, "verifyPhysicalIntegrity"> = {},
): string[] {
  return runSqliteIntegrityOperationSync(
    verifyAndRepairCanonicalSqliteIndexSteps(db, databaseLabel, schemaSql, options),
  );
}

export function* verifyAndRepairCanonicalSqliteIndexSteps(
  db: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  options: Omit<RepairCanonicalSqliteIndexesOptions, "verifyPhysicalIntegrity"> & {
    diagnostics?: SqliteIntegrityDiagnostics;
  } = {},
): SqliteIntegrityOperation<string[]> {
  const { diagnostics, ...repairOptions } = options;
  let integrityFailure: Error | undefined;
  try {
    yield* sqliteIntegrityCheckSteps(db, databaseLabel, diagnostics);
  } catch (error) {
    if (!(error instanceof Error) || !isTerminalSqliteIntegrityError(error)) {
      throw error;
    }
    integrityFailure = error;
  }

  const indexesStartedAt = performance.now();
  const repairedIndexes = repairCanonicalSqliteIndexes(db, databaseLabel, schemaSql, {
    ...repairOptions,
    verifyPhysicalIntegrity: integrityFailure !== undefined,
  });
  // A non-empty repair result already passed table and whole-file integrity
  // checks inside the repair savepoint, so it supersedes the initial failure.
  if (integrityFailure && repairedIndexes.length === 0) {
    throw integrityFailure;
  }
  if (diagnostics) {
    diagnostics.canonicalIndexMs = Math.floor(performance.now() - indexesStartedAt);
    diagnostics.repairedIndexCount = repairedIndexes.length;
  }
  return repairedIndexes;
}

/**
 * Restore every named index when SQLite's IF NOT EXISTS semantics preserve a
 * same-name definition or b-tree that no longer matches the committed schema.
 */
export function repairCanonicalSqliteIndexes(
  db: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  options: RepairCanonicalSqliteIndexesOptions = {},
): string[] {
  const indexes = getCanonicalSqliteNamedIndexContracts(schemaSql);
  const indexesByTable = new Map<string, CanonicalSqliteNamedIndexContract[]>();
  const integrityFailuresByTable = new Map<string, Error>();
  const repairIndexes = new Set<CanonicalSqliteNamedIndexContract>();
  for (const index of indexes) {
    assertSqliteIdentifier(index.name);
    assertSqliteIdentifier(index.tableName);
    const tableExists = db
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
      .get(index.tableName);
    if (!tableExists) {
      continue;
    }
    const tableIndexes = indexesByTable.get(index.tableName) ?? [];
    tableIndexes.push(index);
    indexesByTable.set(index.tableName, tableIndexes);
    const actual = collectSqliteNamedIndexContract(db, index.name);
    if (!isEqual(actual, index.fingerprint)) {
      repairIndexes.add(index);
    }
  }
  assertNoUnexpectedUniqueIndexes(db, databaseLabel, schemaSql, indexesByTable);

  if (options.verifyPhysicalIntegrity !== false) {
    for (const [tableName, tableIndexes] of indexesByTable) {
      try {
        assertSqliteTableIntegrity(db, databaseLabel, tableName);
      } catch (error) {
        if (error instanceof Error) {
          integrityFailuresByTable.set(tableName, error);
        }
        for (const index of tableIndexes) {
          repairIndexes.add(index);
        }
      }
    }
  }
  if (repairIndexes.size === 0) {
    return [];
  }

  const savepoint = "repair_canonical_indexes";
  let activeIndex: CanonicalSqliteNamedIndexContract | undefined;
  db.exec(`SAVEPOINT ${savepoint};`);
  try {
    for (const index of repairIndexes) {
      activeIndex = index;
      const probeName = findUnusedProbeIndexName(db, index.name);
      // Build the canonical constraint first. If existing rows conflict, the
      // wrong same-name index remains in place and the whole repair rolls back.
      try {
        db.exec(createIndexSql(index, probeName, true));
      } catch (error) {
        if (options.allowMissingColumns && isMissingColumnError(error)) {
          repairIndexes.delete(index);
          continue;
        }
        throw error;
      }
      db.exec(`DROP INDEX IF EXISTS main.${index.name};`);
      db.exec(createIndexSql(index, index.name, true));
      db.exec(`DROP INDEX main.${probeName};`);
    }
    if (repairIndexes.size === 0) {
      db.exec(`RELEASE SAVEPOINT ${savepoint};`);
      return [];
    }
    for (const tableName of indexesByTable.keys()) {
      assertSqliteTableIntegrity(db, databaseLabel, tableName);
    }
    assertSqliteIntegrity(db, databaseLabel);
    options.validateAfterRepair?.();
    db.exec(`RELEASE SAVEPOINT ${savepoint};`);
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint};`);
    } finally {
      db.exec(`RELEASE SAVEPOINT ${savepoint};`);
    }
    if (error instanceof Error && isTerminalSqliteIntegrityError(error)) {
      throw error;
    }
    const tableIntegrityFailure = activeIndex
      ? integrityFailuresByTable.get(activeIndex.tableName)
      : undefined;
    if (tableIntegrityFailure && isTerminalSqliteIntegrityError(tableIntegrityFailure)) {
      throw tableIntegrityFailure;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite canonical index ${activeIndex?.name ?? "repair"} failed for ${databaseLabel}: ${detail}`,
      { cause: error },
    );
  }
  return [...repairIndexes].map((index) => index.name).toSorted();
}

function assertNoUnexpectedUniqueIndexes(
  db: DatabaseSync,
  databaseLabel: string,
  schemaSql: string,
  indexesByTable: ReadonlyMap<string, readonly CanonicalSqliteNamedIndexContract[]>,
): void {
  for (const tableName of getCanonicalSqliteTableNames(schemaSql)) {
    assertSqliteIdentifier(tableName);
    const tableExists = db
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
      .get(tableName);
    if (!tableExists) {
      continue;
    }
    const canonicalIndexNames = new Set(
      (indexesByTable.get(tableName) ?? []).map((index) => index.name),
    );
    const unexpected = (
      db.prepare(`PRAGMA main.index_list(${tableName})`).all() as SqliteIndexListRow[]
    ).find(
      (index) => index.unique === 1 && index.origin === "c" && !canonicalIndexNames.has(index.name),
    );
    if (unexpected) {
      throw new Error(
        `SQLite schema is incomplete or noncanonical for ${databaseLabel}: unexpected unique index ${unexpected.name}`,
      );
    }
  }
}

function createIndexSql(
  index: CanonicalSqliteNamedIndexContract,
  name: string,
  qualifyMain: boolean,
): string {
  assertSqliteIdentifier(name);
  const create = index.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
  return `${create} ${qualifyMain ? `main.${name}` : name} ${index.definition};`;
}

function findUnusedProbeIndexName(db: DatabaseSync, canonicalName: string): string {
  const prefix = `openclaw_probe_${canonicalName}`;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? prefix : `${prefix}_${suffix}`;
    const row = db
      .prepare("SELECT 1 AS found FROM main.sqlite_schema WHERE name = ?")
      .get(candidate);
    if (!row) {
      return candidate;
    }
  }
  throw new Error(`could not allocate a probe index name for ${canonicalName}`);
}

function assertSqliteIdentifier(identifier: string): void {
  if (!SQLITE_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`invalid SQLite identifier: ${identifier}`);
  }
}

function isMissingColumnError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    /^no such column:/iu.test(error.message)
  );
}

function isEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
