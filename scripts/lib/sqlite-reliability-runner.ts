import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { compactDoctorSessionSqliteTarget } from "../../src/commands/doctor-session-sqlite-compact.js";
import { runDoctorStateSqliteCompact } from "../../src/commands/doctor-state-sqlite-compact.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { createLocalSqliteSnapshotProvider } from "../../src/snapshot/local-repository.js";
import type { SnapshotDatabaseIdentity } from "../../src/snapshot/snapshot-provider.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.js";
import { runVacuumInterruptionProof } from "./sqlite-reliability-compaction.js";
import {
  COMMITTED_WAL_SENTINEL,
  PROFILES,
  STRESS_TABLE_SQL,
  type CliOptions,
  type ReliabilityReport,
  type ReliabilityStateProof,
} from "./sqlite-reliability-contract.js";
import { runIndexRepairInterruptionProof } from "./sqlite-reliability-index-repair.js";
import { runPublicationInterruptionProof } from "./sqlite-reliability-publication.js";
import { runRepositoryInterruptionProof } from "./sqlite-reliability-repository.js";
import { runRestoreInterruptionProof } from "./sqlite-reliability-restore.js";
import { monitorSqliteWalDuring } from "./sqlite-reliability-wal-monitor.js";
import {
  crashWriter,
  startWriter,
  stopWriter,
  terminateWriter,
  waitForWriterMessage,
  type WriterHandle,
  type WriterExit,
} from "./sqlite-reliability-writer.js";

type TargetDatabase = {
  identity: SnapshotDatabaseIdentity;
  label: string;
  path: string;
};

type IterationMetric = {
  restoreMs: number;
  snapshotBytes: number;
  snapshotMs: number;
};

type CompactionProof = ReliabilityReport["maintenanceProof"]["compaction"];

// Keep 50% headroom above the 2 MiB staged-restore threshold without copying
// an arbitrarily large payload through every repository and restore crash phase.
const COMPACTION_BLOAT_ROWS = 12;
const COMPACTION_BLOAT_PAYLOAD_BYTES = 256 * 1024;
const VACUUM_BLOAT_ROWS = 64;

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

async function runProofsConcurrently<First, Second>(
  first: Promise<First>,
  second: Promise<Second>,
): Promise<[First, Second]> {
  // Wait for both proofs to release their child processes before outer scratch
  // cleanup starts, even when one proof fails.
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  if (firstResult.status === "rejected") {
    throw firstResult.reason;
  }
  if (secondResult.status === "rejected") {
    throw secondResult.reason;
  }
  return [firstResult.value, secondResult.value];
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}

function fileSize(pathname: string): number {
  try {
    return fs.statSync(pathname).size;
  } catch {
    return 0;
  }
}

function resolveTargetDatabase(options: CliOptions, env: NodeJS.ProcessEnv): TargetDatabase {
  if (options.agentId) {
    const database = openOpenClawAgentDatabase({ agentId: options.agentId, env });
    const target = {
      identity: { role: "agent", agentId: database.agentId } as const,
      label: `agent:${database.agentId}`,
      path: database.path,
    };
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    return target;
  }
  const database = openOpenClawStateDatabase({ env });
  const target = {
    identity: { role: "global" } as const,
    label: "global",
    path: database.path,
  };
  closeOpenClawStateDatabaseForTest();
  return target;
}

function setupStressTable(databasePath: string): void {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA busy_timeout = 30000;");
    database.exec(STRESS_TABLE_SQL);
    database.exec("DROP TABLE IF EXISTS openclaw_reliability_compaction_bloat;");
    database.prepare("DELETE FROM openclaw_reliability_entries").run();
    database.prepare("DELETE FROM openclaw_reliability_sentinel").run();
  } finally {
    database.close();
  }
}

function copySnapshotDirectory(sourcePath: string, syncedRepository: string): string {
  fs.mkdirSync(syncedRepository, { recursive: true, mode: 0o700 });
  const destinationPath = path.join(syncedRepository, path.basename(sourcePath));
  fs.cpSync(sourcePath, destinationPath, {
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  return destinationPath;
}

function assertPragmaOk(database: DatabaseSync, pragma: "integrity_check" | "quick_check"): void {
  const rows = database.prepare(`PRAGMA ${pragma};`).all() as Array<Record<string, unknown>>;
  const messages = rows.map((row) => row[pragma]);
  if (messages.length !== 1 || messages[0] !== "ok") {
    throw new Error(`${pragma} failed: ${messages.map(String).join("; ")}`);
  }
}

function sqliteSafeInteger(value: unknown, label: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new Error(`${label} is not a non-negative safe integer: ${String(value)}`);
  }
  return numberValue;
}

function readReliabilityState(database: DatabaseSync, rowsPerBatch: number): ReliabilityStateProof {
  const partial = database
    .prepare(
      `SELECT batch, COUNT(*) AS row_count
         FROM openclaw_reliability_entries
        GROUP BY batch
       HAVING COUNT(*) <> ?
        LIMIT 1`,
    )
    .get(rowsPerBatch) as { batch?: unknown; row_count?: unknown } | undefined;
  if (partial) {
    throw new Error(
      `partial transaction visible: batch=${String(partial.batch)} rows=${String(partial.row_count)}`,
    );
  }

  const hash = createHash("sha256");
  const batches = new Set<number>();
  let rows = 0;
  const entries = database
    .prepare(
      `SELECT batch, ordinal, payload
         FROM openclaw_reliability_entries
        ORDER BY batch, ordinal`,
    )
    .iterate() as Iterable<{ batch?: unknown; ordinal?: unknown; payload?: unknown }>;
  for (const entry of entries) {
    const batch = sqliteSafeInteger(entry.batch, "reliability batch");
    const ordinal = sqliteSafeInteger(entry.ordinal, "reliability ordinal");
    if (typeof entry.payload !== "string") {
      throw new Error(`reliability payload is not text for batch=${batch} ordinal=${ordinal}`);
    }
    hash.update(JSON.stringify([batch, ordinal, entry.payload]));
    hash.update("\n");
    batches.add(batch);
    rows += 1;
  }
  return {
    batches: batches.size,
    rows,
    sha256: hash.digest("hex"),
  };
}

function assertSameReliabilityState(
  actual: ReliabilityStateProof,
  expected: ReliabilityStateProof,
  label: string,
): void {
  if (
    actual.batches !== expected.batches ||
    actual.rows !== expected.rows ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(
      `${label} changed reliability state: expected batches=${expected.batches} rows=${expected.rows} sha256=${expected.sha256}, got batches=${actual.batches} rows=${actual.rows} sha256=${actual.sha256}`,
    );
  }
}

function verifyRestoredDatabase(params: {
  expectedState?: ReliabilityStateProof;
  identity: SnapshotDatabaseIdentity;
  path: string;
  readOnly?: boolean;
  rowsPerBatch: number;
  uncommittedBatch: number | null;
}): ReliabilityStateProof {
  const database = openNodeSqliteDatabase(params.path, {
    readOnly: params.readOnly ?? true,
  });
  try {
    database.exec("PRAGMA trusted_schema = OFF;");
    assertPragmaOk(database, "quick_check");
    assertPragmaOk(database, "integrity_check");
    const foreignKeys = database.prepare("PRAGMA foreign_key_check;").all();
    if (foreignKeys.length > 0) {
      throw new Error(`foreign_key_check failed with ${foreignKeys.length} row(s)`);
    }
    if (params.identity.role === "global") {
      assertOpenClawStateDatabaseForMaintenance(database, { pathname: params.path });
    } else if (params.identity.role === "agent") {
      assertOpenClawAgentDatabaseForMaintenance(database, {
        agentId: params.identity.agentId,
        pathname: params.path,
      });
    }
    const sentinel = database
      .prepare("SELECT payload FROM openclaw_reliability_sentinel WHERE id = 1")
      .get() as { payload?: unknown } | undefined;
    if (sentinel?.payload !== COMMITTED_WAL_SENTINEL) {
      throw new Error("committed WAL sentinel is missing after restore");
    }
    const state = readReliabilityState(database, params.rowsPerBatch);
    if (params.uncommittedBatch !== null) {
      const held = database
        .prepare("SELECT COUNT(*) AS rows FROM openclaw_reliability_entries WHERE batch = ?")
        .get(params.uncommittedBatch) as { rows?: unknown };
      if (Number(held.rows) !== 0) {
        throw new Error(
          `uncommitted transaction became visible after restore: batch=${params.uncommittedBatch} rows=${String(held.rows)}`,
        );
      }
    }
    if (params.expectedState) {
      assertSameReliabilityState(state, params.expectedState, params.path);
    }
    return state;
  } finally {
    database.close();
  }
}

function writeCompactionBloatRange(
  databasePath: string,
  firstId: number,
  lastId: number,
  reset = false,
): void {
  const database = openNodeSqliteDatabase(databasePath);
  const payload = "b".repeat(COMPACTION_BLOAT_PAYLOAD_BYTES);
  try {
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA wal_autocheckpoint = 0;");
    database.exec("PRAGMA busy_timeout = 30000;");
    if (reset) {
      database.exec(`
        DROP TABLE IF EXISTS openclaw_reliability_compaction_bloat;
        CREATE TABLE openclaw_reliability_compaction_bloat (
          id INTEGER PRIMARY KEY,
          payload TEXT NOT NULL
        );
      `);
    }
    database.exec("BEGIN IMMEDIATE;");
    const insert = database.prepare(
      "INSERT INTO openclaw_reliability_compaction_bloat (id, payload) VALUES (?, ?)",
    );
    try {
      for (let id = firstId; id <= lastId; id += 1) {
        insert.run(id, payload);
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    database.close();
  }
}

function readCompactionPayload(databasePath: string): {
  bytes: number;
  idSum: number;
  rows: number;
} {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT
           COUNT(*) AS rows,
           COALESCE(SUM(id), 0) AS id_sum,
           COALESCE(SUM(length(payload)), 0) AS bytes
         FROM openclaw_reliability_compaction_bloat`,
      )
      .get() as { bytes?: unknown; id_sum?: unknown; rows?: unknown };
    return {
      bytes: sqliteSafeInteger(row.bytes, "compaction payload bytes"),
      idSum: sqliteSafeInteger(row.id_sum, "compaction payload id sum"),
      rows: sqliteSafeInteger(row.rows, "compaction payload rows"),
    };
  } finally {
    database.close();
  }
}

function deleteCompactionBloat(databasePath: string, retainThroughId?: number): void {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    if (retainThroughId === undefined) {
      database.exec("DELETE FROM openclaw_reliability_compaction_bloat;");
    } else {
      database
        .prepare("DELETE FROM openclaw_reliability_compaction_bloat WHERE id > ?")
        .run(retainThroughId);
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    database.close();
  }
}

function readAutoVacuum(databasePath: string): number {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA auto_vacuum;").get() as
      | Record<string, unknown>
      | undefined;
    return sqliteSafeInteger(
      row?.auto_vacuum ?? (row ? Object.values(row)[0] : undefined),
      "auto_vacuum",
    );
  } finally {
    database.close();
  }
}

function prepareVacuumRollbackSentinel(databasePath: string): number {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    database.exec(`
      PRAGMA busy_timeout = 30000;
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode = DELETE;
      PRAGMA auto_vacuum = NONE;
      VACUUM;
      PRAGMA journal_mode = WAL;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  } finally {
    database.close();
  }
  const autoVacuum = readAutoVacuum(databasePath);
  if (autoVacuum !== 0) {
    throw new Error(`failed to prepare VACUUM rollback sentinel: auto_vacuum=${autoVacuum}`);
  }
  return autoVacuum;
}

function assertCompactionProof(proof: {
  autoVacuumAfter: number;
  autoVacuumBefore: number;
  databaseBytesAfter: number;
  databaseBytesBefore: number;
  freelistPagesAfter: number;
  freelistPagesBefore: number;
  reclaimedBytes: number;
  walBytesAfter: number;
  walBytesBefore: number;
}): CompactionProof {
  if (proof.autoVacuumAfter !== 2) {
    throw new Error(`compaction did not enable incremental auto_vacuum: ${proof.autoVacuumAfter}`);
  }
  if (proof.freelistPagesBefore <= 0 || proof.freelistPagesAfter !== 0) {
    throw new Error(
      `compaction did not clear the freelist: before=${proof.freelistPagesBefore} after=${proof.freelistPagesAfter}`,
    );
  }
  if (proof.walBytesAfter !== 0) {
    throw new Error(`compaction left a non-empty WAL: ${proof.walBytesAfter} bytes`);
  }
  if (proof.reclaimedBytes <= 0 || proof.databaseBytesAfter >= proof.databaseBytesBefore) {
    throw new Error(
      `compaction did not reclaim file bytes: before=${proof.databaseBytesBefore} after=${proof.databaseBytesAfter} reclaimed=${proof.reclaimedBytes}`,
    );
  }
  return {
    autoVacuum: {
      after: 2,
      before: proof.autoVacuumBefore,
    },
    databaseBytes: {
      after: proof.databaseBytesAfter,
      before: proof.databaseBytesBefore,
    },
    freelistPages: {
      after: 0,
      before: proof.freelistPagesBefore,
    },
    reclaimedBytes: proof.reclaimedBytes,
    walBytes: {
      after: 0,
      before: proof.walBytesBefore,
    },
  };
}

async function compactTargetDatabase(
  target: TargetDatabase,
  env: NodeJS.ProcessEnv,
): Promise<CompactionProof> {
  if (target.identity.role === "global") {
    const report = await runDoctorStateSqliteCompact({ env });
    if (report.skipped) {
      throw new Error(`global compaction unexpectedly skipped ${target.path}`);
    }
    return assertCompactionProof({
      autoVacuumAfter: report.after.autoVacuum,
      autoVacuumBefore: report.before.autoVacuum,
      databaseBytesAfter: report.after.dbSizeBytes,
      databaseBytesBefore: report.before.dbSizeBytes,
      freelistPagesAfter: report.after.freelistPages,
      freelistPagesBefore: report.before.freelistPages,
      reclaimedBytes: report.reclaimedBytes,
      walBytesAfter: report.after.walSizeBytes,
      walBytesBefore: report.before.walSizeBytes,
    });
  }
  if (target.identity.role !== "agent") {
    throw new Error(`unsupported reliability target role: ${target.identity.role}`);
  }
  const autoVacuumBefore = readAutoVacuum(target.path);
  const report = await compactDoctorSessionSqliteTarget(
    { agentId: target.identity.agentId, storePath: target.path },
    { env },
  );
  if (report.skipped) {
    throw new Error(`agent compaction unexpectedly skipped ${target.path}`);
  }
  return assertCompactionProof({
    autoVacuumAfter: readAutoVacuum(target.path),
    autoVacuumBefore,
    databaseBytesAfter: report.dbSizeAfterBytes,
    databaseBytesBefore: report.dbSizeBeforeBytes,
    freelistPagesAfter: report.freelistAfterPages,
    freelistPagesBefore: report.freelistBeforePages,
    reclaimedBytes: report.reclaimedBytes,
    walBytesAfter: report.walSizeAfterBytes,
    walBytesBefore: report.walSizeBeforeBytes,
  });
}

async function runMaintenanceRoundTrip(params: {
  env: NodeJS.ProcessEnv;
  repositoryProvider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  restoreRoot: string;
  rowsPerBatch: number;
  syncedProvider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  syncedRepository: string;
  target: TargetDatabase;
  validationRoot: string;
}): Promise<ReliabilityReport["maintenanceProof"]> {
  const autoVacuumBeforeKill = prepareVacuumRollbackSentinel(params.target.path);
  writeCompactionBloatRange(params.target.path, 1, COMPACTION_BLOAT_ROWS, true);
  const expectedState = verifyRestoredDatabase({
    identity: params.target.identity,
    path: params.target.path,
    rowsPerBatch: params.rowsPerBatch,
    uncommittedBatch: null,
  });
  const expectedPayload = readCompactionPayload(params.target.path);
  if (
    expectedPayload.rows !== COMPACTION_BLOAT_ROWS ||
    expectedPayload.bytes !== COMPACTION_BLOAT_ROWS * COMPACTION_BLOAT_PAYLOAD_BYTES
  ) {
    throw new Error(
      `compaction payload setup failed: rows=${expectedPayload.rows} bytes=${expectedPayload.bytes}`,
    );
  }
  const interruptedSnapshot = await params.repositoryProvider.create({
    identity: params.target.identity,
    path: params.target.path,
  });
  const interruptedCopiedPath = copySnapshotDirectory(
    interruptedSnapshot.ref.path,
    params.syncedRepository,
  );
  const [repositoryInterruption, restoreInterruption] = await runProofsConcurrently(
    runRepositoryInterruptionProof({
      expectedPayload,
      expectedState,
      identity: params.target.identity,
      repositoryPath: path.join(params.restoreRoot, "repository-interruptions"),
      sourcePath: params.target.path,
      validationRootPath: params.validationRoot,
      verifyPayload: readCompactionPayload,
      verifyState: (databasePath) =>
        verifyRestoredDatabase({
          expectedState,
          identity: params.target.identity,
          path: databasePath,
          rowsPerBatch: params.rowsPerBatch,
          uncommittedBatch: null,
        }),
    }),
    runRestoreInterruptionProof({
      expectedPayload,
      expectedSnapshotBytes: interruptedSnapshot.manifest.artifact.sizeBytes,
      expectedState,
      repositoryPath: params.syncedRepository,
      scratchPath: path.join(params.restoreRoot, "interrupted"),
      snapshotPath: interruptedCopiedPath,
      validationRootPath: params.validationRoot,
      verifyPayload: readCompactionPayload,
      verifyState: (databasePath) =>
        verifyRestoredDatabase({
          expectedState,
          identity: params.target.identity,
          path: databasePath,
          rowsPerBatch: params.rowsPerBatch,
          uncommittedBatch: null,
        }),
    }),
  );
  let vacuumInterruption: ReliabilityReport["maintenanceProof"]["vacuumInterruption"];
  try {
    writeCompactionBloatRange(params.target.path, COMPACTION_BLOAT_ROWS + 1, VACUUM_BLOAT_ROWS);
    const vacuumExpectedPayload = readCompactionPayload(params.target.path);
    if (
      vacuumExpectedPayload.rows !== VACUUM_BLOAT_ROWS ||
      vacuumExpectedPayload.bytes !== VACUUM_BLOAT_ROWS * COMPACTION_BLOAT_PAYLOAD_BYTES
    ) {
      throw new Error(
        `vacuum payload setup failed: rows=${vacuumExpectedPayload.rows} bytes=${vacuumExpectedPayload.bytes}`,
      );
    }
    vacuumInterruption = await runVacuumInterruptionProof({
      env: params.env,
      expectedAutoVacuum: autoVacuumBeforeKill,
      expectedPayload: vacuumExpectedPayload,
      expectedState,
      readAutoVacuum: () => readAutoVacuum(params.target.path),
      readPayload: () => readCompactionPayload(params.target.path),
      recoverAndVerifyDatabase: () =>
        verifyRestoredDatabase({
          expectedState,
          identity: params.target.identity,
          path: params.target.path,
          readOnly: false,
          rowsPerBatch: params.rowsPerBatch,
          uncommittedBatch: null,
        }),
      target: params.target,
    });
  } catch (error) {
    try {
      deleteCompactionBloat(params.target.path, COMPACTION_BLOAT_ROWS);
    } catch {
      // Preserve the proof failure; it is the actionable root cause.
    }
    throw error;
  }
  deleteCompactionBloat(params.target.path);
  const compaction = await compactTargetDatabase(params.target, params.env);
  verifyRestoredDatabase({
    expectedState,
    identity: params.target.identity,
    path: params.target.path,
    rowsPerBatch: params.rowsPerBatch,
    uncommittedBatch: null,
  });

  const snapshotStarted = nowMs();
  const snapshot = await params.repositoryProvider.create({
    identity: params.target.identity,
    path: params.target.path,
  });
  const snapshotMs = nowMs() - snapshotStarted;
  const copiedPath = copySnapshotDirectory(snapshot.ref.path, params.syncedRepository);
  const copiedRef = { path: copiedPath };
  await params.syncedProvider.verify(copiedRef);
  const restorePath = path.join(params.restoreRoot, "post-compact.sqlite");
  const restoreStarted = nowMs();
  await params.syncedProvider.restoreFresh(copiedRef, restorePath);
  const restoreMs = nowMs() - restoreStarted;
  const state = verifyRestoredDatabase({
    expectedState,
    identity: params.target.identity,
    path: restorePath,
    rowsPerBatch: params.rowsPerBatch,
    uncommittedBatch: null,
  });
  return {
    bloatBytes: vacuumInterruption.payloadBeforeKill.bytes,
    compaction,
    postCompact: {
      restoreMs: Number(restoreMs.toFixed(3)),
      restoreVerified: true,
      snapshotBytes: snapshot.manifest.artifact.sizeBytes,
      snapshotMs: Number(snapshotMs.toFixed(3)),
      state,
    },
    repositoryInterruption,
    restoreInterruption,
    vacuumInterruption,
  };
}

async function runSnapshotIteration(params: {
  cleanupArtifacts: boolean;
  iteration: number;
  repositoryProvider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  restoreRoot: string;
  rowsPerBatch: number;
  syncedProvider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  syncedRepository: string;
  target: TargetDatabase;
  uncommittedBatch: number | null;
}): Promise<IterationMetric> {
  const snapshotStarted = nowMs();
  const snapshot = await params.repositoryProvider.create({
    identity: params.target.identity,
    path: params.target.path,
  });
  const snapshotMs = nowMs() - snapshotStarted;
  const copiedPath = copySnapshotDirectory(snapshot.ref.path, params.syncedRepository);
  const copiedRef = { path: copiedPath };
  await params.syncedProvider.verify(copiedRef);
  const restorePath = path.join(params.restoreRoot, `restore-${params.iteration}.sqlite`);
  const restoreStarted = nowMs();
  await params.syncedProvider.restoreFresh(copiedRef, restorePath);
  const restoreMs = nowMs() - restoreStarted;
  verifyRestoredDatabase({
    identity: params.target.identity,
    path: restorePath,
    rowsPerBatch: params.rowsPerBatch,
    uncommittedBatch: params.uncommittedBatch,
  });
  if (params.cleanupArtifacts) {
    fs.rmSync(snapshot.ref.path, { force: true, recursive: true });
    fs.rmSync(copiedPath, { force: true, recursive: true });
    fs.rmSync(restorePath, { force: true });
  }
  return {
    restoreMs: Number(restoreMs.toFixed(3)),
    snapshotBytes: snapshot.manifest.artifact.sizeBytes,
    snapshotMs: Number(snapshotMs.toFixed(3)),
  };
}

export async function runReliabilityStress(options: CliOptions): Promise<ReliabilityReport> {
  const profile = PROFILES[options.profile];
  const ownsStateDir = options.stateDir === null;
  const cleanupIterationArtifacts = ownsStateDir && options.repository === null;
  const stateDir =
    options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-reliability-"));
  const repository = options.repository ?? path.join(stateDir, "snapshots");
  const runScratch = path.join(stateDir, "sqlite-reliability-runs", randomUUID());
  const syncedRepository = path.join(runScratch, "synced-snapshots");
  const validationRoot = path.join(runScratch, "snapshot-validation");
  const restoreRoot = path.join(runScratch, "restored");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const started = nowMs();
  let writer: WriterHandle | undefined;
  try {
    fs.mkdirSync(validationRoot, { recursive: true, mode: 0o700 });
    const target = resolveTargetDatabase(options, env);
    setupStressTable(target.path);
    const repositoryProvider = createLocalSqliteSnapshotProvider({
      repositoryPath: repository,
      validationRootPath: validationRoot,
    });
    const syncedProvider = createLocalSqliteSnapshotProvider({
      repositoryPath: syncedRepository,
      validationRootPath: validationRoot,
    });
    writer = startWriter(target.path, profile);
    await waitForWriterMessage(writer, "ready");
    const walBytesBefore = fileSize(`${target.path}-wal`);
    let peakWalBytes = walBytesBefore;
    const partial = await waitForWriterMessage(writer, "partial", () => {
      writer?.child.send?.({ kind: "hold-partial" });
    });
    const stateBeforeKill = verifyRestoredDatabase({
      identity: target.identity,
      path: target.path,
      rowsPerBatch: profile.rowsPerBatch,
      uncommittedBatch: partial.batch,
    });
    let crashExit: WriterExit | undefined;
    let stateAfterRecovery: ReliabilityStateProof | undefined;
    const metrics: IterationMetric[] = [];
    for (let iteration = 0; iteration < profile.iterations; iteration += 1) {
      const iterationProof = await monitorSqliteWalDuring({
        maxWalBytes: profile.maxWalBytes,
        onLimitExceeded: () => {
          try {
            writer?.child.send?.({ kind: "stop" }, () => undefined);
          } catch {
            // The operation still fails on the recorded peak if the writer exited first.
          }
        },
        operation: async () =>
          await runSnapshotIteration({
            cleanupArtifacts: cleanupIterationArtifacts,
            iteration,
            repositoryProvider,
            restoreRoot,
            rowsPerBatch: profile.rowsPerBatch,
            syncedProvider,
            syncedRepository,
            target,
            uncommittedBatch: iteration === 0 ? partial.batch : null,
          }),
        walPath: `${target.path}-wal`,
      });
      metrics.push(iterationProof.result);
      peakWalBytes = Math.max(peakWalBytes, iterationProof.peakWalBytes);
      if (iteration === 0) {
        crashExit = await crashWriter(writer);
        stateAfterRecovery = verifyRestoredDatabase({
          expectedState: stateBeforeKill,
          identity: target.identity,
          path: target.path,
          rowsPerBatch: profile.rowsPerBatch,
          uncommittedBatch: partial.batch,
        });
        writer = startWriter(target.path, profile);
        await waitForWriterMessage(writer, "ready");
      }
    }
    if (!crashExit || !stateAfterRecovery) {
      throw new Error("SQLite reliability stress did not execute its crash recovery proof.");
    }
    const writerResult = await stopWriter(writer);
    const stableState = verifyRestoredDatabase({
      identity: target.identity,
      path: target.path,
      rowsPerBatch: profile.rowsPerBatch,
      uncommittedBatch: null,
    });
    const [publicationInterruptionProof, indexRepairInterruptionProof] =
      await runProofsConcurrently(
        runPublicationInterruptionProof({
          expectedState: stableState,
          scratchPath: path.join(runScratch, "publication-interruptions"),
          sourcePath: target.path,
          verifyDatabase: (databasePath) =>
            verifyRestoredDatabase({
              expectedState: stableState,
              identity: target.identity,
              path: databasePath,
              rowsPerBatch: profile.rowsPerBatch,
              uncommittedBatch: null,
            }),
        }),
        runIndexRepairInterruptionProof(path.join(runScratch, "index-repair-interruptions")),
      );
    const maintenanceProof = await runMaintenanceRoundTrip({
      env,
      repositoryProvider,
      restoreRoot,
      rowsPerBatch: profile.rowsPerBatch,
      syncedProvider,
      syncedRepository,
      target,
      validationRoot,
    });
    const snapshotBytes = metrics.map((metric) => metric.snapshotBytes);
    return {
      arch: process.arch,
      concurrentRestoresVerified: metrics.length,
      crashRecoveryProof: {
        committedStatePreserved: true,
        exit: crashExit,
        partialVisibleAfterRecovery: false,
        sourceRecovered: true,
        stateAfterRecovery,
        stateBeforeKill,
        writerRestarted: true,
      },
      indexRepairInterruptionProof,
      iterations: profile.iterations,
      maintenanceProof,
      node: process.version,
      paths: {
        repository,
        sourceDatabase: target.path,
        stateDir,
        syncedRepository,
      },
      platform: process.platform,
      profile: options.profile,
      publicationInterruptionProof,
      retainedBatches: profile.retainedBatches,
      restoresVerified: metrics.length + 3,
      rowsPerBatch: profile.rowsPerBatch,
      snapshotBytes: {
        max: Math.max(...snapshotBytes),
        min: Math.min(...snapshotBytes),
      },
      target: target.label,
      timingsMs: {
        restoreP50: percentile(
          metrics.map((metric) => metric.restoreMs),
          50,
        ),
        restoreP95: percentile(
          metrics.map((metric) => metric.restoreMs),
          95,
        ),
        snapshotP50: percentile(
          metrics.map((metric) => metric.snapshotMs),
          50,
        ),
        snapshotP95: percentile(
          metrics.map((metric) => metric.snapshotMs),
          95,
        ),
        total: Number((nowMs() - started).toFixed(3)),
      },
      transactionProof: {
        committedWalSentinel: true,
        heldBatch: partial.batch,
        heldRows: partial.rows,
        visibleAfterRestore: false,
      },
      walBytes: {
        after: fileSize(`${target.path}-wal`),
        before: walBytesBefore,
        limit: profile.maxWalBytes,
        peak: peakWalBytes,
      },
      writer: {
        batchesCommitted: partial.batchesCommitted + writerResult.batchesCommitted,
        rowsCommitted: partial.rowsCommitted + writerResult.rowsCommitted,
      },
    };
  } finally {
    if (writer && !writer.stopped) {
      await terminateWriter(writer);
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (ownsStateDir) {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  }
}
