import { randomUUID } from "node:crypto";
// Doctor-only import for the retired meeting-capture JSON/JSONL store.
import fsSync from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { ensureMeetingTranscriptsSchema } from "../transcripts/sqlite-schema.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "./kysely-sync.js";
import { migrationDb } from "./state-migrations.meeting-transcripts-database.js";
import {
  readMeetingTranscriptMigrationDetectionState,
  resolveMeetingTranscriptExportOwnership,
} from "./state-migrations.meeting-transcripts-detection.js";
import {
  archiveLegacyMeetingTranscriptSnapshots,
  archiveDivergentMeetingTranscriptExport,
  archivePartialMeetingTranscriptArtifacts,
  isRecordedCanonicalTranscriptExport,
  LegacyMeetingTranscriptArchiveMovedError,
  listLegacyMeetingTranscriptArtifactDirs,
  listLegacyMeetingTranscriptSessionDirs,
  openLegacyMeetingTranscriptStage,
  rehashLegacyMeetingTranscriptSnapshots,
  restoreCanonicalMeetingTranscriptExports,
  snapshotLegacyMeetingTranscriptSession,
  validateMeetingTranscriptRoot,
  type LegacyMeetingTranscriptSnapshot,
} from "./state-migrations.meeting-transcripts-files.js";
import { insertMeetingTranscriptSnapshots } from "./state-migrations.meeting-transcripts-insert.js";
import { verifyImportedMeetingTranscriptSnapshots } from "./state-migrations.meeting-transcripts-verify.js";
import type { LegacyMeetingTranscriptsDetection } from "./state-migrations.meeting-transcripts.types.js";
import type { MigrationMessages } from "./state-migrations.types.js";

export { detectLegacyMeetingTranscripts } from "./state-migrations.meeting-transcripts-detection.js";

function resolveArchiveRoot(sourceRoot: string, now: number): string {
  const base = `${sourceRoot}.migrated-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
  return fsSync.existsSync(base) ? `${base}-${randomUUID()}` : base;
}

function rollbackImportedSnapshots(params: {
  snapshots: LegacyMeetingTranscriptSnapshot[];
  runId: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): void {
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      const db = migrationDb(database);
      for (const snapshot of params.snapshots) {
        executeSqliteQuerySync(
          database,
          db
            .deleteFrom("meeting_transcript_sessions")
            .where("session_id", "=", snapshot.session.sessionId)
            .where("started_at", "=", snapshot.session.startedAt),
        );
      }
      executeSqliteQuerySync(
        database,
        db.deleteFrom("migration_sources").where("last_run_id", "=", params.runId),
      );
      executeSqliteQuerySync(
        database,
        db.deleteFrom("migration_runs").where("id", "=", params.runId),
      );
    },
    { env: { ...params.env, OPENCLAW_STATE_DIR: params.stateDir } },
    { operationLabel: "meeting-transcripts.legacy-import.rollback" },
  );
}

function finishPendingMigration(params: {
  runId: string;
  archiveRoot: string;
  now: number;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): void {
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      const db = migrationDb(database);
      executeSqliteQuerySync(
        database,
        db
          .updateTable("migration_sources")
          .set({ status: "archived", removed_source: 1 })
          .where("last_run_id", "=", params.runId)
          .where("migration_kind", "=", "meeting-transcripts-files-v1"),
      );
      const run = executeSqliteQueryTakeFirstSync(
        database,
        db.selectFrom("migration_runs").select("report_json").where("id", "=", params.runId),
      );
      const report = run ? (JSON.parse(run.report_json) as Record<string, unknown>) : {};
      executeSqliteQuerySync(
        database,
        db
          .updateTable("migration_runs")
          .set({
            finished_at: params.now,
            status: "completed",
            report_json: JSON.stringify({ ...report, archiveRoot: params.archiveRoot }),
          })
          .where("id", "=", params.runId),
      );
    },
    { env: { ...params.env, OPENCLAW_STATE_DIR: params.stateDir } },
    { operationLabel: "meeting-transcripts.legacy-import.finish" },
  );
}

type PendingImportRun = {
  runId: string;
  archiveRoot: string;
  canonicalRelativeDirs: string[];
  sources: Array<{ sourcePath: string; sourceHash: string }>;
};

function isStrictRelativePathWithinRoot(root: string, relativePath: string): boolean {
  if (!relativePath || relativePath === "." || path.isAbsolute(relativePath)) {
    return false;
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function snapshotPendingImportRun(params: {
  run: PendingImportRun;
  snapshotRoot: string;
  sourceRoot: string;
  stageDatabase: DatabaseSync;
}): Promise<{ snapshots: LegacyMeetingTranscriptSnapshot[]; hashesMatch: boolean }> {
  const snapshots: LegacyMeetingTranscriptSnapshot[] = [];
  let hashesMatch = true;
  for (const source of params.run.sources) {
    const relativeDir = path.relative(params.sourceRoot, source.sourcePath) || ".";
    if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
      throw new Error(`pending meeting transcript source escaped its root: ${source.sourcePath}`);
    }
    const snapshot = await snapshotLegacyMeetingTranscriptSession({
      rootDir: params.snapshotRoot,
      relativeDir,
      stageDatabase: params.stageDatabase,
    });
    snapshots.push(snapshot);
    hashesMatch &&= snapshot.sourceHash === source.sourceHash;
  }
  return { snapshots, hashesMatch };
}

function readPendingImportRuns(params: {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  sourceRoot: string;
}): PendingImportRun[] {
  const database = openOpenClawStateDatabase({
    env: { ...params.env, OPENCLAW_STATE_DIR: params.stateDir },
  });
  const db = migrationDb(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("migration_sources as source")
      .innerJoin("migration_runs as run", "run.id", "source.last_run_id")
      .select([
        "source.last_run_id as run_id",
        "source.source_path",
        "source.source_sha256",
        "run.report_json as run_report_json",
      ])
      .where("source.migration_kind", "=", "meeting-transcripts-files-v1")
      .where("source.status", "=", "imported")
      .where("source.removed_source", "=", 0)
      .orderBy("source.source_path", "asc"),
  ).rows;
  const runs = new Map<string, PendingImportRun>();
  for (const row of rows) {
    const report = JSON.parse(row.run_report_json) as Record<string, unknown>;
    const format = report.format;
    const archiveRoot = report.archiveRoot;
    const canonicalRelativeDirs = report.canonicalRelativeDirs;
    if (
      typeof archiveRoot !== "string" ||
      format !== "meeting-transcripts-files-v1" ||
      !archiveRoot.startsWith(`${params.sourceRoot}.migrated-`) ||
      !Array.isArray(canonicalRelativeDirs) ||
      !canonicalRelativeDirs.every(
        (relativeDir) =>
          typeof relativeDir === "string" &&
          isStrictRelativePathWithinRoot(params.sourceRoot, relativeDir),
      ) ||
      typeof row.source_sha256 !== "string"
    ) {
      throw new Error(`invalid pending meeting transcript migration receipt: ${row.run_id}`);
    }
    const run: PendingImportRun = runs.get(row.run_id) ?? {
      runId: row.run_id,
      archiveRoot,
      canonicalRelativeDirs,
      sources: [],
    };
    if (
      run.archiveRoot !== archiveRoot ||
      JSON.stringify(run.canonicalRelativeDirs) !== JSON.stringify(canonicalRelativeDirs)
    ) {
      throw new Error(`conflicting meeting transcript archive receipts: ${row.run_id}`);
    }
    run.sources.push({ sourcePath: row.source_path, sourceHash: row.source_sha256 });
    runs.set(row.run_id, run);
  }
  return [...runs.values()];
}

async function listCanonicalMeetingTranscriptExportDirs(params: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const state = readMeetingTranscriptMigrationDetectionState({ env: params.env });
  const relativeDirs = await listLegacyMeetingTranscriptArtifactDirs(params.rootDir);
  return relativeDirs.filter((relativeDir) => {
    const selector = relativeDir.split(path.sep).join("/");
    const sessionDir = path.join(params.rootDir, relativeDir);
    const ownership = resolveMeetingTranscriptExportOwnership({
      state,
      selector,
      sessionDir,
      sourceRoot: params.rootDir,
    });
    return Boolean(
      ownership &&
      isRecordedCanonicalTranscriptExport({
        sessionDir,
        manifest: ownership.manifest,
        pending: ownership.pending,
      }),
    );
  });
}

async function resumePendingImports(params: {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  sourceRoot: string;
  store: TranscriptsStore;
  stageDatabase: DatabaseSync;
}): Promise<MigrationMessages | undefined> {
  const runs = readPendingImportRuns(params);
  if (runs.length === 0) {
    return undefined;
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const run of runs) {
    if (fsSync.existsSync(run.archiveRoot)) {
      try {
        const archived = await snapshotPendingImportRun({
          run,
          snapshotRoot: run.archiveRoot,
          sourceRoot: params.sourceRoot,
          stageDatabase: params.stageDatabase,
        });
        if (!archived.hashesMatch) {
          throw new Error("archived source hashes do not match migration receipts");
        }
        const database = openOpenClawStateDatabase({
          env: { ...params.env, OPENCLAW_STATE_DIR: params.stateDir },
        });
        await verifyImportedMeetingTranscriptSnapshots({
          store: params.store,
          snapshots: archived.snapshots,
          stageDatabase: params.stageDatabase,
          database: database.db,
        });
        await restoreCanonicalMeetingTranscriptExports({
          sourceRoot: params.sourceRoot,
          archiveRoot: run.archiveRoot,
          migratedSourcePaths: run.sources.map((source) => source.sourcePath),
          canonicalRelativeDirs: run.canonicalRelativeDirs,
        });
        finishPendingMigration({
          runId: run.runId,
          archiveRoot: run.archiveRoot,
          now: Date.now(),
          env: params.env,
          stateDir: params.stateDir,
        });
        changes.push(`Finalized interrupted meeting transcript archive → ${run.archiveRoot}`);
      } catch (error) {
        warnings.push(
          `Pending meeting transcript migration ${run.runId} archive could not be verified or restored; left its rows and files for recovery: ${String(error)}`,
        );
      }
      continue;
    }
    if (!fsSync.existsSync(params.sourceRoot)) {
      warnings.push(
        `Pending meeting transcript migration ${run.runId} has neither source tree nor archive`,
      );
      continue;
    }
    const canonicalRelativeDirs = [
      ...new Set([
        ...run.canonicalRelativeDirs,
        ...(await listCanonicalMeetingTranscriptExportDirs({
          rootDir: params.sourceRoot,
          env: { ...params.env, OPENCLAW_STATE_DIR: params.stateDir },
        })),
      ]),
    ];
    const expectedRelativeDirs = [
      ...new Set([
        ...run.sources.map((source) => path.relative(params.sourceRoot, source.sourcePath) || "."),
        ...canonicalRelativeDirs,
      ]),
    ].toSorted((a, b) => a.localeCompare(b));
    const pending = await snapshotPendingImportRun({
      run,
      snapshotRoot: params.sourceRoot,
      sourceRoot: params.sourceRoot,
      stageDatabase: params.stageDatabase,
    });
    if (!pending.hashesMatch) {
      warnings.push(
        `Pending meeting transcript migration ${run.runId} source tree changed; left its imported rows and files for manual recovery`,
      );
      continue;
    }
    const database = openOpenClawStateDatabase({
      env: { ...params.env, OPENCLAW_STATE_DIR: params.stateDir },
    });
    await verifyImportedMeetingTranscriptSnapshots({
      store: params.store,
      snapshots: pending.snapshots,
      stageDatabase: params.stageDatabase,
      database: database.db,
    });
    await archiveLegacyMeetingTranscriptSnapshots({
      sourceRoot: params.sourceRoot,
      snapshots: pending.snapshots,
      expectedRelativeDirs,
      canonicalRelativeDirs,
      archiveRoot: run.archiveRoot,
    });
    finishPendingMigration({
      runId: run.runId,
      archiveRoot: run.archiveRoot,
      now: Date.now(),
      env: params.env,
      stateDir: params.stateDir,
    });
    changes.push(`Resumed and archived meeting transcript migration → ${run.archiveRoot}`);
  }
  return { changes, warnings };
}

export async function migrateLegacyMeetingTranscripts(params: {
  detected?: LegacyMeetingTranscriptsDetection;
  env?: NodeJS.ProcessEnv;
  stateDir: string;
  now?: () => number;
  testHooks?: {
    afterImport?: () => void;
    afterArchive?: () => void;
  };
}): Promise<MigrationMessages> {
  const detected = params.detected;
  if (!detected?.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  const env = params.env ?? process.env;
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env: { ...env, OPENCLAW_STATE_DIR: params.stateDir },
      role: "sqlite-maintenance",
      timeoutMs: 5_000,
    });
  } catch (error) {
    return {
      changes: [],
      warnings: [
        `Skipped meeting transcript migration because exclusive state ownership is unavailable: ${String(error)}`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: [
        "Skipped meeting transcript migration because exclusive state ownership is unavailable",
      ],
    };
  }

  let stageDatabase: DatabaseSync | undefined;
  let stagePath: string | undefined;
  const recoveryChanges: string[] = [];
  try {
    fsSync.mkdirSync(params.stateDir, { recursive: true });
    stagePath = path.join(params.stateDir, `.meeting-transcripts-migration-${randomUUID()}.sqlite`);
    const stage = openLegacyMeetingTranscriptStage(stagePath);
    stageDatabase = stage;
    await validateMeetingTranscriptRoot(detected.sourceDir, { allowMissing: true });
    const databaseOptions = { env: { ...env, OPENCLAW_STATE_DIR: params.stateDir } };
    ensureMeetingTranscriptsSchema(databaseOptions);
    const store = new TranscriptsStore(detected.sourceDir, databaseOptions);
    const resumed = await resumePendingImports({
      env,
      stateDir: params.stateDir,
      sourceRoot: detected.sourceDir,
      store,
      stageDatabase: stage,
    });
    if (resumed) {
      return resumed;
    }
    const now = params.now?.() ?? Date.now();
    const relativeDirs = await listLegacyMeetingTranscriptArtifactDirs(detected.sourceDir);
    const sessionRelativeDirs = await listLegacyMeetingTranscriptSessionDirs(detected.sourceDir);
    const sessionRelativeDirSet = new Set(sessionRelativeDirs);
    const detectionState = readMeetingTranscriptMigrationDetectionState({
      env: { ...env, OPENCLAW_STATE_DIR: params.stateDir },
    });
    const legacyRelativeDirs: string[] = [];
    const partialRelativeDirs: string[] = [];
    const divergentExportDirs: Array<{ relativeDir: string; ownerSelector: string }> = [];
    for (const relativeDir of relativeDirs) {
      const selector = relativeDir.split(path.sep).join("/");
      const ownership = resolveMeetingTranscriptExportOwnership({
        state: detectionState,
        selector,
        sessionDir: path.join(detected.sourceDir, relativeDir),
        sourceRoot: detected.sourceDir,
      });
      if (
        ownership &&
        isRecordedCanonicalTranscriptExport({
          sessionDir: path.join(detected.sourceDir, relativeDir),
          manifest: ownership.manifest,
          pending: ownership.pending,
        })
      ) {
        continue;
      }
      if (ownership) {
        divergentExportDirs.push({ relativeDir, ownerSelector: ownership.selector });
      } else if (!sessionRelativeDirSet.has(relativeDir)) {
        partialRelativeDirs.push(relativeDir);
      } else {
        legacyRelativeDirs.push(relativeDir);
      }
    }
    const snapshots: LegacyMeetingTranscriptSnapshot[] = [];
    for (const relativeDir of legacyRelativeDirs) {
      snapshots.push(
        await snapshotLegacyMeetingTranscriptSession({
          rootDir: detected.sourceDir,
          relativeDir,
          stageDatabase: stage,
        }),
      );
    }
    const plans: LegacyMeetingTranscriptSnapshot[] = [];
    for (const snapshot of snapshots) {
      const database = openOpenClawStateDatabase(databaseOptions);
      const existing = executeSqliteQueryTakeFirstSync(
        database.db,
        migrationDb(database.db)
          .selectFrom("meeting_transcript_sessions")
          .select("session_id")
          .where("session_id", "=", snapshot.session.sessionId)
          .where("started_at", "=", snapshot.session.startedAt),
      );
      if (existing) {
        throw new Error(
          `legacy transcript conflicts with canonical SQLite state: ${snapshot.relativeDir}`,
        );
      }
      plans.push(snapshot);
    }
    if (divergentExportDirs.length > 0) {
      const recoveryRoot = `${detected.sourceDir}.exports-recovered-${new Date(now)
        .toISOString()
        .replace(/[:.]/g, "-")}`;
      for (const { relativeDir, ownerSelector } of divergentExportDirs) {
        const session = await store.readSession(ownerSelector);
        if (!session) {
          throw new Error(`divergent transcript export has no SQLite owner: ${relativeDir}`);
        }
        await archiveDivergentMeetingTranscriptExport({
          sourceRoot: detected.sourceDir,
          relativeDir,
          recoveryRoot,
        });
        recoveryChanges.push(
          `Archived modified meeting transcript export ${relativeDir} → ${recoveryRoot}`,
        );
        await store.materializeSessionArtifacts(session, "all");
      }
    }
    if (plans.length === 0 && partialRelativeDirs.length > 0) {
      const recoveryRoot = `${detected.sourceDir}.partials-recovered-${new Date(now)
        .toISOString()
        .replace(/[:.]/g, "-")}`;
      await archivePartialMeetingTranscriptArtifacts({
        sourceRoot: detected.sourceDir,
        relativeDirs: partialRelativeDirs,
        recoveryRoot,
      });
      recoveryChanges.push(
        `Archived ${partialRelativeDirs.length} incomplete meeting transcript director${partialRelativeDirs.length === 1 ? "y" : "ies"} → ${recoveryRoot}`,
      );
    }
    const expectedArchiveRelativeDirs = await listLegacyMeetingTranscriptSessionDirs(
      detected.sourceDir,
    );
    if (plans.length === 0) {
      return { changes: recoveryChanges, warnings: [] };
    }

    const runId = randomUUID();
    const archiveRoot = resolveArchiveRoot(detected.sourceDir, now);
    const canonicalRelativeDirs = await listCanonicalMeetingTranscriptExportDirs({
      rootDir: detected.sourceDir,
      env: { ...env, OPENCLAW_STATE_DIR: params.stateDir },
    });
    insertMeetingTranscriptSnapshots({
      snapshots: plans,
      runId,
      now,
      archiveRoot,
      canonicalRelativeDirs,
      stageDatabase: stage,
      env,
      stateDir: params.stateDir,
    });
    try {
      const database = openOpenClawStateDatabase(databaseOptions);
      await verifyImportedMeetingTranscriptSnapshots({
        store,
        snapshots: plans,
        stageDatabase: stage,
        database: database.db,
      });
      if (!(await rehashLegacyMeetingTranscriptSnapshots(plans))) {
        rollbackImportedSnapshots({ snapshots: plans, runId, env, stateDir: params.stateDir });
        return {
          changes: recoveryChanges,
          warnings: [
            "Legacy meeting transcript files changed after import; rolled back SQLite rows and left every source in place for a Doctor retry",
          ],
        };
      }
    } catch (error) {
      rollbackImportedSnapshots({ snapshots: plans, runId, env, stateDir: params.stateDir });
      throw error;
    }
    params.testHooks?.afterImport?.();
    let archiveRootAfterMove: string;
    try {
      archiveRootAfterMove = await archiveLegacyMeetingTranscriptSnapshots({
        sourceRoot: detected.sourceDir,
        snapshots: plans,
        expectedRelativeDirs: expectedArchiveRelativeDirs,
        canonicalRelativeDirs,
        archiveRoot,
      });
    } catch (error) {
      if (error instanceof LegacyMeetingTranscriptArchiveMovedError) {
        return {
          changes: [
            ...recoveryChanges,
            `Imported ${plans.length} meeting transcript session${plans.length === 1 ? "" : "s"} into shared SQLite state`,
          ],
          warnings: [
            `Meeting transcript archive needs Doctor resume after moving the source tree: ${String(error)}`,
          ],
        };
      }
      rollbackImportedSnapshots({ snapshots: plans, runId, env, stateDir: params.stateDir });
      return {
        changes: recoveryChanges,
        warnings: [
          `Failed archiving verified legacy meeting transcripts; rolled back SQLite rows and left every source in place for Doctor retry: ${String(error)}`,
        ],
      };
    }
    params.testHooks?.afterArchive?.();
    finishPendingMigration({
      runId,
      archiveRoot: archiveRootAfterMove,
      now,
      env,
      stateDir: params.stateDir,
    });
    const utteranceCount = plans.reduce((total, snapshot) => total + snapshot.utteranceCount, 0);
    return {
      changes: [
        ...recoveryChanges,
        `Migrated ${plans.length} meeting transcript session${plans.length === 1 ? "" : "s"} and ${utteranceCount} utterance${utteranceCount === 1 ? "" : "s"} to shared SQLite state`,
        `Archived legacy meeting transcript files → ${archiveRootAfterMove}`,
      ],
      warnings: [],
    };
  } catch (error) {
    return {
      changes: recoveryChanges,
      warnings: [`Failed migrating meeting transcripts: ${String(error)}`],
    };
  } finally {
    try {
      stageDatabase?.close();
      if (stagePath) {
        fsSync.rmSync(stagePath, { force: true });
        fsSync.rmSync(`${stagePath}-shm`, { force: true });
        fsSync.rmSync(`${stagePath}-wal`, { force: true });
      }
    } finally {
      await lock.release();
    }
  }
}
