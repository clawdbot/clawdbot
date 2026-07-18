import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionFilePath } from "../config/sessions/paths.js";
import {
  importSqliteSessionRows,
  loadExactSqliteSessionEntry,
} from "../config/sessions/session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import { normalizeSessionEntryDelivery } from "../config/sessions/store-load.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
  type SessionStoreTarget,
} from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveStoredSessionOwnerAgentId } from "../gateway/session-store-key.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { compactDoctorSessionSqliteTarget } from "./doctor-session-sqlite-compact.js";
import {
  assertSafeSessionSqliteMigrationDirectory,
  assertSafeSessionSqliteMigrationMove,
  canonicalMigrationFilePath,
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMove,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMove,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationFailureReports,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationMoveKind,
  type SessionSqliteMigrationTargetInput,
} from "./doctor-session-sqlite-migration-run.js";
import {
  countTranscriptEventsForPath,
  createTranscriptEventReader,
  createTranscriptEventPrefixReader,
  readOnlySqliteDbStats,
  readOnlySqliteExactSessionEntry,
  readOnlySqliteSessionEntries,
  readOnlySqliteTranscriptEventCount,
  readSqliteEntryCount,
  resolveTargetSqlitePath,
} from "./doctor-session-sqlite-readers.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import { restoreDoctorSessionSqliteTargets } from "./doctor-session-sqlite-restore-report.js";
import type {
  DoctorSessionSqliteIssue,
  DoctorSessionSqliteMode,
  DoctorSessionSqliteOptions,
  DoctorSessionSqliteReport,
  DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";
export {
  restoreSessionSqliteMigrationRun,
  writeSessionSqliteMigrationFailureReports,
} from "./doctor-session-sqlite-migration-run.js";
export type {
  DoctorSessionSqliteIssue,
  DoctorSessionSqliteMode,
  DoctorSessionSqliteOptions,
  DoctorSessionSqliteReport,
  DoctorSessionSqliteRestoreConflict,
  DoctorSessionSqliteRestoreReport,
  DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";

type LegacySessionRecord = {
  entry: SessionEntry;
  sessionKey: string;
  transcriptPath?: string;
};

const WARNING_ISSUE_CODES = new Set([
  "transcript_missing",
  "transcript_archive_failed",
  "transcript_malformed",
  "unreferenced_jsonl_archive_failed",
]);

/** Runs the targeted doctor SQLite session migration/inspection submode. */
export async function runDoctorSessionSqlite(
  options: DoctorSessionSqliteOptions,
): Promise<DoctorSessionSqliteReport> {
  const env = options.env ?? process.env;
  const cfg = resolveDoctorSessionSqliteConfig(options);
  const targets = resolveDoctorSessionSqliteTargets({
    allAgents: options.allAgents,
    agent: options.agent,
    cfg,
    env,
    mode: options.mode,
    store: options.store,
  });
  if (options.mode === "restore") {
    return restoreDoctorSessionSqliteTargets({
      env,
      targets,
    });
  }
  if (options.mode === "recover") {
    return recoverDoctorSessionSqliteTargets({
      env,
      options,
      targets,
      validateTarget: (target) => inspectOrMigrateTarget({ cfg, env, mode: "validate", target }),
    });
  }
  const activeRun =
    options.mode === "import" && targets.length > 0
      ? createSessionSqliteMigrationRun(env, targets.map(createMigrationTargetInput))
      : undefined;
  const fullyCoveredStorePaths =
    options.mode === "import"
      ? resolveFullyCoveredLegacyStorePaths(cfg, targets)
      : new Set<string>();
  const reports: DoctorSessionSqliteTargetReport[] = [];
  for (const target of targets) {
    reports.push(
      await inspectOrMigrateTarget({
        activeRun,
        archiveImportedArtifacts: fullyCoveredStorePaths.has(path.resolve(target.storePath)),
        cfg,
        env,
        mode: options.mode,
        target,
      }),
    );
  }
  if (activeRun) {
    archiveImportedLegacySessionStores(targets, reports, activeRun, fullyCoveredStorePaths);
    const hasIssues = reports.some((report) => report.issues.length > 0);
    activeRun.manifest.completedAt = new Date().toISOString();
    if (hasIssues) {
      activeRun.manifest.failedAt = activeRun.manifest.completedAt;
      const failureReports = writeSessionSqliteMigrationFailureReports(activeRun.manifestPath, {
        reason: "doctor import reported session SQLite migration issues",
      });
      activeRun.manifest.failureReports = failureReports;
    }
    writeSessionSqliteMigrationManifest(activeRun);
  }
  return summarizeDoctorSessionSqliteReport(options.mode, reports, activeRun);
}

// Direct store migrations are scoped by path; broader agent discovery needs runtime config.
function resolveDoctorSessionSqliteConfig(options: DoctorSessionSqliteOptions): OpenClawConfig {
  if (options.cfg) {
    return options.cfg;
  }
  return options.store ? {} : getRuntimeConfig();
}

function resolveDoctorSessionSqliteTargets(params: {
  allAgents?: boolean;
  agent?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
}): SessionStoreTarget[] {
  if (params.store) {
    return filterLegacySessionStoreTargets(
      resolveSessionStoreTargets(params.cfg, { store: params.store }, { env: params.env }),
      params.mode,
    );
  }
  if (params.mode === "restore" || params.mode === "recover") {
    const candidates = resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
      env: params.env,
    });
    if (!params.agent) {
      return candidates;
    }
    const requestedAgentId = normalizeAgentId(params.agent);
    return candidates.filter((target) => normalizeAgentId(target.agentId) === requestedAgentId);
  }
  if (params.agent) {
    return filterLegacySessionStoreTargets(
      resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, { env: params.env }),
      params.mode,
    );
  }
  if (params.allAgents) {
    return filterLegacySessionStoreTargets(
      resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env }),
      params.mode,
    );
  }
  return resolveSessionStoreTargets(params.cfg, {}, { env: params.env }).filter((target) =>
    fs.existsSync(target.storePath),
  );
}

function filterLegacySessionStoreTargets(
  targets: SessionStoreTarget[],
  mode: DoctorSessionSqliteMode,
): SessionStoreTarget[] {
  if (mode === "inspect" || mode === "compact" || mode === "restore" || mode === "recover") {
    return targets;
  }
  return targets.filter((target) => fs.existsSync(target.storePath));
}

async function inspectOrMigrateTarget(params: {
  activeRun?: ActiveSessionSqliteMigrationRun;
  archiveImportedArtifacts?: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: Exclude<DoctorSessionSqliteMode, "restore" | "recover">;
  target: SessionStoreTarget;
}): Promise<DoctorSessionSqliteTargetReport> {
  const issues: DoctorSessionSqliteIssue[] = [];
  const allRecords = readLegacySessionRecords(params.target, issues, {
    allowMissingStore: params.mode === "inspect" || params.mode === "compact",
  });
  const records = shouldFilterLegacySessionRecordsByTarget(params.target)
    ? allRecords.filter((record) =>
        isLegacySessionRecordOwnedByTarget(params.cfg, params.target, record.sessionKey),
      )
    : allRecords;
  const referencedTranscriptFiles = new Set(
    allRecords.flatMap((record) => (record.transcriptPath ? [record.transcriptPath] : [])),
  );
  const report: DoctorSessionSqliteTargetReport = {
    agentId: params.target.agentId,
    archivedLegacyStoreFiles: [],
    archivedTranscriptFiles: [],
    archivedUnreferencedJsonlFiles: [],
    importedEntries: 0,
    importedTranscriptEvents: 0,
    issues,
    legacyEntries: records.length,
    referencedTranscriptFiles: referencedTranscriptFiles.size,
    sqliteEntries: readSqliteEntryCount(params.target),
    sqlitePath: resolveTargetSqlitePath(params.target),
    storePath: params.target.storePath,
    unreferencedJsonlFiles: listUnreferencedJsonlFiles(params.target.storePath, [
      ...referencedTranscriptFiles,
    ]),
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
  };
  if (params.mode === "inspect") {
    report.sqliteEntries = readSqliteEntryCount(params.target);
    appendSqliteDbStats(params.target, report);
    appendActiveSqliteTranscriptFileIssues(params.target, report);
    return report;
  }
  if (params.mode === "compact") {
    compactSqliteDatabase(params.target, report, { env: params.env });
    report.sqliteEntries = readSqliteEntryCount(params.target);
    appendSqliteDbStats(params.target, report);
    return report;
  }
  for (const record of records) {
    if (params.mode === "dry-run") {
      countLegacyTranscript(record, report);
      continue;
    }
    if (params.mode === "import") {
      await importLegacySessionRecord(params.target, record, report);
      continue;
    }
    validateLegacySessionRecord(params.target, record, report);
  }
  if (params.mode === "import" && blockingIssueCount(report) === 0) {
    const validationPassed = validateImportedTargetBeforeArchive(params.target, records, report);
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      report.issues,
      {
        validationBeforeArchive: validationPassed ? "passed" : "failed",
      },
    );
    if (validationPassed && params.archiveImportedArtifacts !== false) {
      archiveImportedTranscripts(params.target, records, report, params.activeRun);
      archiveUnreferencedJsonlFiles(
        params.target,
        report,
        [...referencedTranscriptFiles],
        params.activeRun,
      );
    }
    if (validationPassed) {
      // Post-import compact retrofits auto_vacuum=INCREMENTAL onto pre-flip
      // databases and returns the pages the import churn freed.
      compactSqliteDatabase(params.target, report, {
        closeImportedHandle: true,
        env: params.env,
        migrateOlderSchema: true,
      });
    }
  }
  report.unreferencedJsonlFiles = listUnreferencedJsonlFiles(params.target.storePath, [
    ...referencedTranscriptFiles,
  ]);
  report.sqliteEntries = readSqliteEntryCount(params.target);
  appendActiveSqliteTranscriptFileIssues(params.target, report);
  updateMigrationManifestTarget(
    params.activeRun,
    createMigrationTargetInput(params.target),
    report.issues,
  );
  return report;
}

function resolveFullyCoveredLegacyStorePaths(
  cfg: OpenClawConfig,
  targets: readonly SessionStoreTarget[],
): Set<string> {
  const covered = new Set<string>();
  const targetsByStore = new Map<string, SessionStoreTarget[]>();
  for (const target of targets) {
    const storePath = path.resolve(target.storePath);
    targetsByStore.set(storePath, [...(targetsByStore.get(storePath) ?? []), target]);
  }
  for (const [storePath, storeTargets] of targetsByStore) {
    const [firstStoreTarget] = storeTargets;
    if (!firstStoreTarget) {
      continue;
    }
    const issues: DoctorSessionSqliteIssue[] = [];
    const records = readLegacySessionRecords(firstStoreTarget, issues);
    const coversEveryRecord = records.every((record) =>
      storeTargets.some(
        (target) =>
          !shouldFilterLegacySessionRecordsByTarget(target) ||
          isLegacySessionRecordOwnedByTarget(cfg, target, record.sessionKey),
      ),
    );
    if (issues.length === 0 && coversEveryRecord) {
      covered.add(storePath);
    }
  }
  return covered;
}

function readLegacySessionRecords(
  target: SessionStoreTarget,
  issues: DoctorSessionSqliteIssue[],
  options: { allowMissingStore?: boolean } = {},
): LegacySessionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target.storePath, "utf-8"));
  } catch (err) {
    if (
      options.allowMissingStore === true &&
      (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) {
      return [];
    }
    issues.push({
      code: "store_unreadable",
      message: `${target.storePath}: ${String(err)}`,
    });
    return [];
  }
  if (!isRecord(parsed)) {
    issues.push({
      code: "store_not_object",
      message: `${target.storePath} does not contain an object session store.`,
    });
    return [];
  }
  const records: LegacySessionRecord[] = [];
  for (const [sessionKey, value] of Object.entries(parsed)) {
    if (!isSessionEntry(value)) {
      issues.push({
        code: "entry_invalid",
        message: "Session entry is missing a valid sessionId.",
        sessionKey,
      });
      continue;
    }
    records.push({
      // Import is the migration boundary: repair legacy delivery/route shapes
      // here because the SQLite runtime read path assumes canonical entries.
      entry: normalizeSessionEntryDelivery(value),
      sessionKey,
      transcriptPath: resolveLegacyTranscriptPath(target, value),
    });
  }
  return records;
}

function isLegacySessionRecordOwnedByTarget(
  cfg: OpenClawConfig,
  target: SessionStoreTarget,
  sessionKey: string,
): boolean {
  const ownerAgentId = resolveStoredSessionOwnerAgentId({
    cfg,
    agentId: target.agentId,
    sessionKey,
  });
  return ownerAgentId
    ? ownerAgentId === target.agentId
    : target.agentId === resolveDefaultAgentId(cfg);
}

function shouldFilterLegacySessionRecordsByTarget(target: SessionStoreTarget): boolean {
  return !resolveSqliteTargetFromSessionStorePath(target.storePath).agentId;
}

function resolveLegacyTranscriptPath(
  target: SessionStoreTarget,
  entry: SessionEntry,
): string | undefined {
  if (parseSqliteSessionFileMarker(entry.sessionFile)) {
    return undefined;
  }
  const defaultPath = resolveSessionFilePath(entry.sessionId, entry, {
    agentId: target.agentId,
    sessionsDir: path.dirname(target.storePath),
  });
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  return entry.sessionFile?.trim() ? defaultPath : undefined;
}

function countLegacyTranscript(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): void {
  const result = countTranscriptEvents(record);
  if (result.status === "missing") {
    report.issues.push({
      code: "transcript_missing",
      message: `Transcript file is missing: ${record.transcriptPath}`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (result.status === "malformed") {
    report.issues.push({
      code: "transcript_malformed",
      message: result.message,
      sessionKey: record.sessionKey,
    });
    return;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents += result.events;
}

function blockingIssueCount(report: DoctorSessionSqliteTargetReport): number {
  return report.issues.filter((issue) => !WARNING_ISSUE_CODES.has(issue.code)).length;
}

async function importLegacySessionRecord(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): Promise<void> {
  const result = countTranscriptEvents(record);
  const transcriptMtimeMs = readLegacyTranscriptMtimeMs(record);
  if (result.status === "missing") {
    if (markAlreadyMigratedTranscript(target, record, report)) {
      return;
    }
    const imported = await importSqliteSessionRows({
      agentId: target.agentId,
      entry: record.entry,
      sessionKey: record.sessionKey,
      storePath: target.storePath,
    });
    report.importedEntries += 1;
    report.importedTranscriptEvents += imported.transcriptEvents;
    report.issues.push({
      code: "transcript_missing",
      message: `Transcript file is missing: ${record.transcriptPath}`,
      sessionKey: record.sessionKey,
    });
    return;
  } else if (result.status === "malformed") {
    const imported = await importSqliteSessionRows({
      agentId: target.agentId,
      entry: record.entry,
      sessionKey: record.sessionKey,
      storePath: target.storePath,
      ...(record.transcriptPath
        ? { readTranscriptEvents: createTranscriptEventPrefixReader(record.transcriptPath) }
        : {}),
      ...(transcriptMtimeMs !== undefined ? { transcriptMtimeMs } : {}),
    });
    report.importedEntries += 1;
    report.importedTranscriptEvents += imported.transcriptEvents;
    report.issues.push({
      code: "transcript_malformed",
      message: result.message,
      sessionKey: record.sessionKey,
    });
    return;
  }
  const imported = await importSqliteSessionRows({
    agentId: target.agentId,
    entry: record.entry,
    sessionKey: record.sessionKey,
    storePath: target.storePath,
    ...(record.transcriptPath && result.status === "ok"
      ? { readTranscriptEvents: createTranscriptEventReader(record.transcriptPath) }
      : {}),
    ...(transcriptMtimeMs !== undefined ? { transcriptMtimeMs } : {}),
  });
  report.importedEntries += 1;
  report.importedTranscriptEvents += imported.transcriptEvents;
}

function markAlreadyMigratedTranscript(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): boolean {
  const migratedEvents = countAlreadyMigratedTranscriptEventsForImport(target, record);
  if (migratedEvents === undefined) {
    return false;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents += migratedEvents;
  return true;
}

function validateImportedTargetBeforeArchive(
  target: SessionStoreTarget,
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
): boolean {
  const issueCountBeforeValidation = report.issues.length;
  for (const record of records) {
    validateImportedRecordBeforeArchive(target, record, report);
  }
  return report.issues.length === issueCountBeforeValidation;
}

function validateImportedRecordBeforeArchive(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): void {
  const normalizedKey = normalizeStoreSessionKey(record.sessionKey);
  const sqliteEntry = loadExactSqliteSessionEntry({
    agentId: target.agentId,
    sessionKey: normalizedKey,
    storePath: target.storePath,
  });
  if (!sqliteEntry) {
    report.issues.push({
      code: "sqlite_entry_missing",
      message: `SQLite entry is missing for ${normalizedKey}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (sqliteEntry.entry.sessionId !== record.entry.sessionId) {
    report.issues.push({
      code: "sqlite_entry_mismatch",
      message: `SQLite sessionId ${sqliteEntry.entry.sessionId} does not match ${record.entry.sessionId}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  const result = countTranscriptEvents(record);
  if (result.status === "missing") {
    return;
  }
  if (result.status !== "ok") {
    if (!hasSessionIssue(report, "transcript_malformed", record.sessionKey)) {
      report.issues.push({
        code: "transcript_malformed",
        message: result.message,
        sessionKey: record.sessionKey,
      });
    }
    return;
  }
  const sqliteEvents = readOnlySqliteTranscriptEventCount(target, record.entry.sessionId);
  if (!sqliteEvents.ok) {
    report.issues.push({
      code: "sqlite_read_failed",
      message: `SQLite transcript count read failed: ${String(sqliteEvents.error)}`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (sqliteEvents.events < result.events) {
    report.issues.push({
      code: "sqlite_transcript_count_mismatch",
      message: `SQLite transcript has ${sqliteEvents.events} events; source has ${result.events}.`,
      sessionKey: record.sessionKey,
    });
  }
}

function archiveImportedTranscript(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
): void {
  if (!record.transcriptPath || !fs.existsSync(record.transcriptPath)) {
    return;
  }
  try {
    report.archivedTranscriptFiles.push(
      ...moveImportedTranscriptArtifactsToArchive(
        target,
        record.sessionKey,
        record.transcriptPath,
        activeRun,
      ),
    );
  } catch (err) {
    report.issues.push({
      code: "transcript_archive_failed",
      message: `${record.transcriptPath}: ${String(err)}`,
      sessionKey: record.sessionKey,
    });
  }
}

function archiveImportedTranscripts(
  target: SessionStoreTarget,
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
): void {
  const archivedTranscriptPaths = new Set<string>();
  for (const record of records) {
    if (!record.transcriptPath || archivedTranscriptPaths.has(record.transcriptPath)) {
      continue;
    }
    archiveImportedTranscript(target, record, report, activeRun);
    archivedTranscriptPaths.add(record.transcriptPath);
  }
}

function archiveUnreferencedJsonlFiles(
  target: SessionStoreTarget,
  report: DoctorSessionSqliteTargetReport,
  referencedPaths: readonly string[],
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
): void {
  const reservedArchivePaths = new Set<string>();
  const plannedMoves = listUnreferencedJsonlFiles(target.storePath, referencedPaths).flatMap(
    (sourcePath) => {
      try {
        const move = planSessionJsonlArchiveMove({
          archiveKey: "archive-tier",
          baseNameRaw: path.basename(sourcePath),
          kind: "unreferenced-jsonl",
          reservedArchivePaths,
          sourcePathRaw: sourcePath,
          target,
        });
        reservedArchivePaths.add(move.archivePath);
        return [move];
      } catch (err) {
        report.issues.push({
          code: "unreferenced_jsonl_archive_failed",
          message: `${sourcePath}: ${String(err)}`,
        });
        return [];
      }
    },
  );
  // Persist every source/destination before the first rename. A crash can then
  // restore moved files even when the completion checkpoint was never written.
  recordPlannedMigrationMoves(activeRun, createMigrationTargetInput(target), plannedMoves);
  const completedMoves: SessionSqliteMigrationMove[] = [];
  const migrationTarget = createMigrationTargetInput(target);
  for (const move of plannedMoves) {
    try {
      assertSafeSessionSqliteMigrationMove(move, migrationTarget);
      fs.renameSync(move.sourcePath, move.archivePath);
      report.archivedUnreferencedJsonlFiles.push(move.archivePath);
      completedMoves.push(move);
    } catch (err) {
      report.issues.push({
        code: "unreferenced_jsonl_archive_failed",
        message: `${move.sourcePath}: ${String(err)}`,
      });
    }
  }
  recordCompletedMigrationMoves(activeRun, createMigrationTargetInput(target), completedMoves);
}

function archiveImportedLegacySessionStores(
  targets: readonly SessionStoreTarget[],
  reports: readonly DoctorSessionSqliteTargetReport[],
  activeRun: ActiveSessionSqliteMigrationRun,
  fullyCoveredStorePaths: ReadonlySet<string>,
): void {
  const byStore = new Map<
    string,
    { report: DoctorSessionSqliteTargetReport; target: SessionStoreTarget }[]
  >();
  for (const target of targets) {
    const report = reports.find(
      (candidate) =>
        candidate.agentId === target.agentId &&
        path.resolve(candidate.storePath) === path.resolve(target.storePath),
    );
    if (!report) {
      continue;
    }
    const key = path.resolve(target.storePath);
    byStore.set(key, [...(byStore.get(key) ?? []), { report, target }]);
  }
  for (const [storePath, entries] of byStore) {
    if (!fullyCoveredStorePaths.has(storePath)) {
      continue;
    }
    if (entries.some((entry) => blockingIssueCount(entry.report) > 0)) {
      continue;
    }
    const [firstEntry] = entries;
    if (!firstEntry) {
      continue;
    }
    const archivePath = archiveLegacySessionStore(firstEntry.target, firstEntry.report, activeRun);
    if (!archivePath) {
      continue;
    }
    for (const entry of entries.slice(1)) {
      recordLegacyStoreMoveForTarget(entry.target, archivePath, activeRun);
    }
  }
}

function archiveLegacySessionStore(
  target: SessionStoreTarget,
  report: DoctorSessionSqliteTargetReport,
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
): string | undefined {
  if (!fs.existsSync(target.storePath)) {
    return undefined;
  }
  try {
    const archivePath = moveSessionJsonlToArchive({
      activeRun,
      archiveKey: "legacy-store",
      baseNameRaw: path.basename(target.storePath),
      kind: "legacy-store",
      sourcePathRaw: target.storePath,
      target,
    });
    (report.archivedLegacyStoreFiles ??= []).push(archivePath);
    return archivePath;
  } catch (err) {
    report.issues.push({
      code: "legacy_store_archive_failed",
      message: `${target.storePath}: ${String(err)}`,
    });
    return undefined;
  }
}

function recordLegacyStoreMoveForTarget(
  target: SessionStoreTarget,
  archivePath: string,
  activeRun: ActiveSessionSqliteMigrationRun,
): void {
  const move = {
    archivePath,
    kind: "legacy-store" as const,
    sourcePath: path.resolve(target.storePath),
  };
  recordPlannedMigrationMove(activeRun, createMigrationTargetInput(target), move);
  recordCompletedMigrationMove(activeRun, createMigrationTargetInput(target), move);
}

function validateLegacySessionRecord(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): void {
  const normalizedKey = normalizeStoreSessionKey(record.sessionKey);
  const sqliteEntry = readOnlySqliteExactSessionEntry(target, normalizedKey);
  if (!sqliteEntry.ok) {
    report.issues.push({
      code: "sqlite_read_failed",
      message: `SQLite session entry read failed: ${String(sqliteEntry.error)}`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (!sqliteEntry.entry) {
    report.issues.push({
      code: "sqlite_entry_missing",
      message: `SQLite entry is missing for ${normalizedKey}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (sqliteEntry.entry.entry.sessionId !== record.entry.sessionId) {
    report.issues.push({
      code: "sqlite_entry_mismatch",
      message: `SQLite sessionId ${sqliteEntry.entry.entry.sessionId} does not match ${record.entry.sessionId}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  report.validatedEntries += 1;
  validateTranscriptEventCount(target, record, report);
}

function validateTranscriptEventCount(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
): void {
  const result = countTranscriptEvents(record);
  if (result.status === "missing") {
    const migratedEvents = countAlreadyMigratedTranscriptEventsForValidate(target, record);
    if (migratedEvents !== undefined) {
      report.validatedTranscriptEvents += migratedEvents;
    }
    return;
  }
  if (result.status !== "ok") {
    if (!hasSessionIssue(report, "transcript_malformed", record.sessionKey)) {
      report.issues.push({
        code: "transcript_malformed",
        message: result.message,
        sessionKey: record.sessionKey,
      });
    }
    return;
  }
  const sqliteEvents = readOnlySqliteTranscriptEventCount(target, record.entry.sessionId);
  if (!sqliteEvents.ok) {
    report.issues.push({
      code: "sqlite_read_failed",
      message: `SQLite transcript count read failed: ${String(sqliteEvents.error)}`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (sqliteEvents.events !== result.events) {
    report.issues.push({
      code: "sqlite_transcript_count_mismatch",
      message: `SQLite transcript has ${sqliteEvents.events} events; source has ${result.events}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  report.validatedTranscriptEvents += sqliteEvents.events;
}

function hasSessionIssue(
  report: DoctorSessionSqliteTargetReport,
  code: string,
  sessionKey: string,
): boolean {
  return report.issues.some((issue) => issue.code === code && issue.sessionKey === sessionKey);
}

function countAlreadyMigratedTranscriptEventsForImport(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
): number | undefined {
  const normalizedKey = normalizeStoreSessionKey(record.sessionKey);
  const sqliteEntry = loadExactSqliteSessionEntry({
    agentId: target.agentId,
    sessionKey: normalizedKey,
    storePath: target.storePath,
  });
  if (sqliteEntry?.entry.sessionId !== record.entry.sessionId) {
    return undefined;
  }
  const eventCount = readOnlySqliteTranscriptEventCount(target, record.entry.sessionId);
  return eventCount.ok ? eventCount.events : undefined;
}

function countAlreadyMigratedTranscriptEventsForValidate(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
): number | undefined {
  const normalizedKey = normalizeStoreSessionKey(record.sessionKey);
  const sqliteEntry = readOnlySqliteExactSessionEntry(target, normalizedKey);
  if (!sqliteEntry.ok || sqliteEntry.entry?.entry.sessionId !== record.entry.sessionId) {
    return undefined;
  }
  const eventCount = readOnlySqliteTranscriptEventCount(target, record.entry.sessionId);
  return eventCount.ok ? eventCount.events : undefined;
}

function countTranscriptEvents(
  record: LegacySessionRecord,
):
  | { status: "ok"; events: number }
  | { status: "missing" }
  | { status: "malformed"; message: string } {
  return countTranscriptEventsForPath(record.transcriptPath);
}

function readLegacyTranscriptMtimeMs(record: LegacySessionRecord): number | undefined {
  if (!record.transcriptPath) {
    return undefined;
  }
  try {
    const mtimeMs = Math.floor(fs.statSync(record.transcriptPath).mtimeMs);
    return Number.isFinite(mtimeMs) && mtimeMs >= 0 ? mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function listUnreferencedJsonlFiles(
  storePath: string,
  referencedPaths: readonly string[],
): string[] {
  const sessionsDir = path.dirname(storePath);
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const referenced = new Set(referencedPaths.map((filePath) => canonicalFilePath(filePath)));
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => path.join(sessionsDir, entry))
    .filter((filePath) => !referenced.has(canonicalFilePath(filePath)))
    .toSorted((a, b) => a.localeCompare(b));
}

function appendActiveSqliteTranscriptFileIssues(
  target: SessionStoreTarget,
  report: DoctorSessionSqliteTargetReport,
): void {
  const result = readOnlySqliteSessionEntries(target);
  if (!result.ok) {
    report.issues.push({
      code: "sqlite_active_transcript_scan_failed",
      message: `Could not scan SQLite-backed sessions for active JSONL transcript files: ${String(result.error)}`,
    });
    return;
  }
  for (const summary of result.summaries) {
    const transcriptPath = resolveActiveSqliteTranscriptFile(target, summary.entry);
    if (!transcriptPath) {
      continue;
    }
    report.issues.push({
      code: "active_sqlite_transcript_jsonl",
      message: `SQLite-backed session still has an active JSONL transcript file: ${transcriptPath}`,
      sessionKey: summary.sessionKey,
    });
  }
}

function appendSqliteDbStats(
  target: SessionStoreTarget,
  report: DoctorSessionSqliteTargetReport,
): void {
  const result = readOnlySqliteDbStats(target);
  if (!result.ok) {
    report.issues.push({
      code: "sqlite_corrupt",
      message: `SQLite database could not be inspected: ${String(result.error)}`,
    });
    return;
  }
  report.dbStats = result.stats;
  if (result.stats.integrityCheck && result.stats.integrityCheck !== "ok") {
    report.issues.push({
      code: "sqlite_integrity_check_failed",
      message: `SQLite quick_check reported: ${result.stats.integrityCheck}`,
    });
  }
}

function compactSqliteDatabase(
  target: SessionStoreTarget,
  report: DoctorSessionSqliteTargetReport,
  options: {
    closeImportedHandle?: boolean;
    env?: NodeJS.ProcessEnv;
    migrateOlderSchema?: boolean;
  } = {},
): void {
  try {
    if (options.closeImportedHandle) {
      closeOpenClawAgentDatabaseByPath(resolveTargetSqlitePath(target));
    }
    report.compact = options.migrateOlderSchema
      ? compactDoctorSessionSqliteTarget(target, {
          env: options.env,
          migrateOlderSchema: true,
        })
      : compactDoctorSessionSqliteTarget(target, { env: options.env });
  } catch (err) {
    report.issues.push({
      code: "sqlite_compact_failed",
      message: `SQLite database compact failed: ${String(err)}`,
    });
  }
}

function resolveActiveSqliteTranscriptFile(
  target: SessionStoreTarget,
  entry: SessionEntry,
): string | undefined {
  let transcriptPath: string;
  try {
    transcriptPath = resolveSessionFilePath(entry.sessionId, entry, {
      agentId: target.agentId,
      sessionsDir: path.dirname(target.storePath),
    });
  } catch {
    return undefined;
  }
  if (!transcriptPath.endsWith(".jsonl")) {
    return undefined;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) {
    return undefined;
  }
  const sessionsDir = canonicalFilePath(path.dirname(target.storePath));
  const activePath = canonicalFilePath(transcriptPath);
  if (path.dirname(activePath) !== sessionsDir) {
    return undefined;
  }
  return activePath;
}

function moveImportedTranscriptArtifactsToArchive(
  target: SessionStoreTarget,
  sessionKey: string,
  transcriptPath: string,
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
): string[] {
  const archived = [
    moveImportedTranscriptToArchive(target, sessionKey, transcriptPath, "transcript", activeRun),
  ];
  const trajectoryPath = resolveTrajectoryPath(transcriptPath);
  if (trajectoryPath && fs.existsSync(trajectoryPath)) {
    archived.push(
      moveImportedTranscriptToArchive(target, sessionKey, trajectoryPath, "trajectory", activeRun),
    );
  }
  const trajectoryPointerPath = resolveTrajectoryPointerPath(transcriptPath);
  if (trajectoryPointerPath && fs.existsSync(trajectoryPointerPath)) {
    archived.push(
      moveImportedTranscriptToArchive(
        target,
        sessionKey,
        trajectoryPointerPath,
        "trajectory",
        activeRun,
      ),
    );
  }
  return archived;
}

function resolveTrajectoryPath(transcriptPath: string): string | undefined {
  return transcriptPath.endsWith(".jsonl")
    ? `${transcriptPath.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : undefined;
}

function resolveTrajectoryPointerPath(transcriptPath: string): string | undefined {
  return transcriptPath.endsWith(".jsonl")
    ? `${transcriptPath.slice(0, -".jsonl".length)}.trajectory-path.json`
    : undefined;
}

function moveImportedTranscriptToArchive(
  target: SessionStoreTarget,
  sessionKey: string,
  sourcePathRaw: string,
  kind: SessionSqliteMigrationMoveKind,
  activeRun: ActiveSessionSqliteMigrationRun | undefined,
): string {
  return moveSessionJsonlToArchive({
    activeRun,
    archiveKey: sessionKey,
    baseNameRaw: path.basename(sourcePathRaw),
    kind,
    sessionKey,
    sourcePathRaw,
    target,
  });
}

function moveSessionJsonlToArchive(params: {
  activeRun: ActiveSessionSqliteMigrationRun | undefined;
  archiveKey: string;
  baseNameRaw: string;
  kind: SessionSqliteMigrationMoveKind;
  sessionKey?: string;
  sourcePathRaw: string;
  target: SessionStoreTarget;
}): string {
  const move = planSessionJsonlArchiveMove(params);
  const migrationTarget = createMigrationTargetInput(params.target);
  recordPlannedMigrationMove(params.activeRun, migrationTarget, move);
  assertSafeSessionSqliteMigrationMove(move, migrationTarget);
  fs.renameSync(move.sourcePath, move.archivePath);
  recordCompletedMigrationMove(params.activeRun, migrationTarget, move);
  return move.archivePath;
}

function planSessionJsonlArchiveMove(params: {
  archiveKey: string;
  baseNameRaw: string;
  kind: SessionSqliteMigrationMoveKind;
  reservedArchivePaths?: ReadonlySet<string>;
  sessionKey?: string;
  sourcePathRaw: string;
  target: SessionStoreTarget;
}): SessionSqliteMigrationMove {
  const sourcePathRaw = path.resolve(params.sourcePathRaw);
  const stat = fs.lstatSync(sourcePathRaw);
  if (!stat.isFile()) {
    throw new Error("source is not a regular file");
  }
  const sourcePath = path.join(
    canonicalFilePath(path.dirname(sourcePathRaw)),
    path.basename(sourcePathRaw),
  );
  const sessionsDir = canonicalFilePath(path.dirname(path.resolve(params.target.storePath)));
  if (path.dirname(sourcePath) !== sessionsDir) {
    throw new Error(`Migration source is outside the target sessions directory: ${sourcePath}`);
  }
  const archiveDir = resolveImportedTranscriptArchiveDir(params.target.storePath);
  assertSafeSessionSqliteMigrationDirectory(archiveDir);
  fs.mkdirSync(archiveDir, { recursive: true });
  assertSafeSessionSqliteMigrationDirectory(archiveDir);
  const baseName = params.baseNameRaw.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 160) || "artifact";
  const keySlug = params.archiveKey.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "session";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `.${attempt}`;
    const archivePath = path.join(
      archiveDir,
      `${keySlug}.${baseName}.imported-${Date.now()}${suffix}`,
    );
    if (fs.existsSync(archivePath) || params.reservedArchivePaths?.has(archivePath)) {
      continue;
    }
    return {
      archivePath,
      kind: params.kind,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      sourcePath,
    };
  }
  throw new Error(`Could not archive ${baseName} for ${params.archiveKey}`);
}

function resolveImportedTranscriptArchiveDir(storePath: string): string {
  const storeDir = canonicalFilePath(path.dirname(path.resolve(storePath)));
  return path.join(path.dirname(storeDir), "session-sqlite-import-archive");
}

function canonicalFilePath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function createMigrationTargetInput(target: SessionStoreTarget): SessionSqliteMigrationTargetInput {
  return {
    agentId: target.agentId,
    sqlitePath: canonicalMigrationFilePath(resolveTargetSqlitePath(target)),
    storePath: canonicalMigrationFilePath(target.storePath),
  };
}

function isSessionEntry(value: unknown): value is SessionEntry {
  return isRecord(value) && typeof value.sessionId === "string" && value.sessionId.trim() !== "";
}

function summarizeDoctorSessionSqliteReport(
  mode: DoctorSessionSqliteMode,
  targets: DoctorSessionSqliteTargetReport[],
  activeRun?: ActiveSessionSqliteMigrationRun,
): DoctorSessionSqliteReport {
  return {
    ...(activeRun
      ? {
          migrationRun: {
            ...(activeRun.manifest.failureReports
              ? {
                  failureReportJsonPath: activeRun.manifest.failureReports.jsonPath,
                  failureReportMarkdownPath: activeRun.manifest.failureReports.markdownPath,
                }
              : {}),
            manifestPath: activeRun.manifestPath,
            runId: activeRun.manifest.runId,
          },
        }
      : {}),
    mode,
    targets,
    totals: {
      archivedLegacyStoreFiles: targets.reduce(
        (total, target) => total + (target.archivedLegacyStoreFiles?.length ?? 0),
        0,
      ),
      archivedTranscriptFiles: targets.reduce(
        (total, target) => total + target.archivedTranscriptFiles.length,
        0,
      ),
      archivedUnreferencedJsonlFiles: targets.reduce(
        (total, target) => total + target.archivedUnreferencedJsonlFiles.length,
        0,
      ),
      importedEntries: sumTargets(targets, "importedEntries"),
      importedTranscriptEvents: sumTargets(targets, "importedTranscriptEvents"),
      issues: targets.reduce((total, target) => total + target.issues.length, 0),
      legacyEntries: sumTargets(targets, "legacyEntries"),
      reclaimedBytes: targets.reduce(
        (total, target) => total + (target.compact?.reclaimedBytes ?? 0),
        0,
      ),
      sqliteEntries: sumTargets(targets, "sqliteEntries"),
      targets: targets.length,
      unreferencedJsonlFiles: targets.reduce(
        (total, target) => total + target.unreferencedJsonlFiles.length,
        0,
      ),
      validatedEntries: sumTargets(targets, "validatedEntries"),
      validatedTranscriptEvents: sumTargets(targets, "validatedTranscriptEvents"),
    },
  };
}

function sumTargets(
  targets: DoctorSessionSqliteTargetReport[],
  key: keyof Pick<
    DoctorSessionSqliteTargetReport,
    | "importedEntries"
    | "importedTranscriptEvents"
    | "legacyEntries"
    | "sqliteEntries"
    | "validatedEntries"
    | "validatedTranscriptEvents"
  >,
): number {
  return targets.reduce((total, target) => total + target[key], 0);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
