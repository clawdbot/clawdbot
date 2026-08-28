import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveStateDir } from "../config/paths.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionFilePathCore } from "../config/sessions/paths.js";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
  type SessionStoreTarget as ResolvedSessionStoreTarget,
} from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveStoredSessionOwnerAgentId } from "../gateway/session-store-key.js";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeLegacySessionEntryDelivery as normalizeSessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { compactDoctorSessionSqliteTarget } from "./doctor-session-sqlite-compact.js";
import {
  assertSafeSessionSqliteMigrationDirectory,
  assertSafeSessionSqliteMigrationMove,
  canonicalMigrationFilePath,
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMoves,
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
  readOnlySqliteDbStats,
  readOnlySqliteValidationSnapshot,
  readTranscriptFingerprint,
  readSqliteEntryCount,
  resolveTargetSqlitePath,
  scanReadOnlySqliteActiveTranscriptFiles,
  type ReadOnlySqliteValidationSnapshot,
} from "./doctor-session-sqlite-readers.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import { restoreDoctorSessionSqliteTargets } from "./doctor-session-sqlite-restore-report.js";
import {
  createDoctorSessionSqliteTotals,
  createDoctorSessionSqliteTargetReport,
  isSessionSqliteMigrationWarning,
  sumDoctorSessionSqliteTargets,
  type DoctorSessionSqliteIssue,
  type DoctorSessionSqliteMode,
  type DoctorSessionSqliteOptions,
  type DoctorSessionSqliteReport,
  type DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";
import {
  assertDoctorSqliteMaintenancePathsNotAliased,
  isDestructiveDoctorSessionSqliteMode,
} from "./doctor-sqlite-maintenance-lock.js";
export type {
  DoctorSessionSqliteOptions,
  DoctorSessionSqliteReport,
} from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

type LegacySessionRecord = {
  entry: SessionEntry;
  sessionKey: string;
  transcriptPath?: string;
};

const SESSION_IMPORT_BATCH_SIZE = 256;

/**
 * Runs the targeted doctor SQLite session migration/inspection submode.
 * Destructive production callers hold the Gateway/SQLite-maintenance state lock for the full call.
 */
export async function runDoctorSessionSqlite(
  options: DoctorSessionSqliteOptions,
): Promise<DoctorSessionSqliteReport> {
  const env = options.env ?? process.env;
  const cfg = resolveDoctorSessionSqliteConfig(options);
  const targets = filterLegacySessionStoreTargets(
    resolveDoctorSessionSqliteTargets({ ...options, cfg, env }),
    options.mode,
  );
  if (isDestructiveDoctorSessionSqliteMode(options.mode)) {
    const maintenancePaths = resolveDoctorSessionSqliteMaintenancePaths(targets);
    assertDoctorSqliteMaintenancePathsNotAliased(
      `session SQLite ${options.mode}`,
      maintenancePaths,
      resolveDoctorSessionSqliteMaintenanceRoots(targets, env),
    );
  }
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
    const hasBlockingIssues = reports.some((report) => blockingIssueCount(report) > 0);
    activeRun.manifest.completedAt = new Date().toISOString();
    if (hasBlockingIssues) {
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

function resolveDoctorSessionSqliteMaintenancePaths(
  targets: readonly SessionStoreTarget[],
): string[] {
  const protectedPaths = new Set<string>();
  for (const target of targets) {
    for (const databasePath of resolveSqliteDatabaseFilePaths(resolveTargetSqlitePath(target))) {
      protectedPaths.add(databasePath);
    }
  }
  return [...protectedPaths];
}

function resolveDoctorSessionSqliteMaintenanceRoots(
  targets: readonly SessionStoreTarget[],
  env: NodeJS.ProcessEnv,
): string[] {
  const stateDir = path.resolve(resolveStateDir(env));
  const roots = new Set([stateDir]);
  for (const target of targets) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (isPathWithin(stateDir, target.storePath) && isPathWithin(stateDir, sqlitePath)) {
      continue;
    }
    const commonRoot = commonPathAncestor(path.dirname(target.storePath), path.dirname(sqlitePath));
    const parentRoot = path.dirname(commonRoot);
    roots.add(parentRoot === path.parse(commonRoot).root ? commonRoot : parentRoot);
  }
  return [...roots];
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  return isPathInside(rootPath, path.resolve(candidatePath));
}

function commonPathAncestor(leftPath: string, rightPath: string): string {
  let currentPath = path.resolve(leftPath);
  const resolvedRightPath = path.resolve(rightPath);
  while (!isPathWithin(currentPath, resolvedRightPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }
    currentPath = parentPath;
  }
  return currentPath;
}

// Direct store migrations are scoped by path; broader agent discovery needs runtime config.
function resolveDoctorSessionSqliteConfig(options: DoctorSessionSqliteOptions): OpenClawConfig {
  if (options.cfg) {
    return options.cfg;
  }
  const requestedAgentId = normalizeAgentId(options.agent ?? LEGACY_IMPLICIT_AGENT_ID);
  return options.store
    ? { agents: { entries: { [requestedAgentId]: { default: true } } } }
    : getRuntimeConfig();
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
    return resolveSessionStoreTargets(params.cfg, { store: params.store }, { env: params.env });
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
    return resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, { env: params.env });
  }
  if (params.allAgents) {
    const targets = resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env });
    if (params.mode !== "dry-run" && params.mode !== "import" && params.mode !== "validate") {
      return targets;
    }
    const legacyStorePath = path.join(resolveStateDir(params.env), "sessions", "sessions.json");
    if (!fs.existsSync(legacyStorePath)) {
      return targets;
    }
    const legacyTargets = resolveSessionStoreTargets(
      params.cfg,
      { allAgents: true },
      { env: params.env },
    ).map((target) => ({
      agentId: target.agentId,
      sqlitePath: resolveTargetSqlitePath(target),
      storePath: legacyStorePath,
    }));
    return [...legacyTargets, ...targets];
  }
  return resolveSessionStoreTargets(params.cfg, {}, { env: params.env });
}

function filterLegacySessionStoreTargets(
  targets: SessionStoreTarget[],
  mode: DoctorSessionSqliteMode,
): SessionStoreTarget[] {
  if (mode === "inspect" || mode === "compact" || mode === "restore" || mode === "recover") {
    return targets;
  }
  return targets.filter(
    (target) => !target.storePath.endsWith(".sqlite") && fs.existsSync(target.storePath),
  );
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
  // Exact SQLite locators are maintenance targets, never legacy import sources.
  // Keeping them out of the file path also prevents archiving a live database.
  const isSqliteStore = params.target.storePath.endsWith(".sqlite");
  const allRecords = isSqliteStore
    ? []
    : readLegacySessionRecords(params.target, issues, {
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
  const report = createDoctorSessionSqliteTargetReport({
    agentId: params.target.agentId,
    archivedLegacyStoreFiles: [],
    issues,
    legacyEntries: records.length,
    referencedTranscriptFiles: referencedTranscriptFiles.size,
    sqliteEntries: readSqliteEntryCount(params.target),
    sqlitePath: resolveTargetSqlitePath(params.target),
    storePath: params.target.storePath,
    unreferencedJsonlFiles: isSqliteStore
      ? []
      : listUnreferencedJsonlFiles(params.target.storePath, [...referencedTranscriptFiles]),
  });
  if (params.mode === "compact") {
    await compactSqliteDatabase(params.target, report, { env: params.env });
    report.sqliteEntries = readSqliteEntryCount(params.target);
  }
  if (isSqliteStore || params.mode === "inspect" || params.mode === "compact") {
    appendSqliteDbStats(params.target, report);
    if (params.mode !== "compact") {
      appendActiveSqliteTranscriptFileIssues(params.target, report);
    }
    return report;
  }
  if (params.mode === "import") {
    await importLegacySessionRecords(params.target, records, report);
  } else if (params.mode === "dry-run") {
    for (const record of records) {
      countLegacyTranscript(record, report);
    }
  } else {
    validateLegacySessionRecords(params.target, records, report);
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
      // Finalization enables incremental vacuum where needed and releases free pages.
      await compactSqliteDatabase(params.target, report, {
        env: params.env,
        operation: "import-finalize",
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
    if (issues.every(isSessionSqliteMigrationWarning) && coversEveryRecord) {
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
  // Open a file descriptor first, then stat and read through it to eliminate
  // the TOCTOU race where a file can change between size validation and read.
  // Use O_NONBLOCK so a path substituted with a FIFO cannot block waiting for
  // a writer; fstat on the descriptor then rejects non-regular files.
  const openFlags =
    process.platform === "win32" ? "r" : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  let fd: number;
  try {
    fd = fs.openSync(target.storePath, openFlags);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (options.allowMissingStore === true && nodeErr.code === "ENOENT") {
      try {
        const parentStat = fs.statSync(path.dirname(target.storePath));
        if (!parentStat.isDirectory()) {
          issues.push({
            code: "store_unreadable",
            message: `${target.storePath}: parent path is not a directory`,
          });
        }
      } catch (parentErr) {
        if ((parentErr as NodeJS.ErrnoException).code !== "ENOENT") {
          issues.push({
            code: "store_unreadable",
            message: `${target.storePath}: ${String(parentErr)}`,
          });
        }
      }
      return [];
    }
    issues.push({
      code: "store_unreadable",
      message: `${target.storePath}: ${String(err)}`,
    });
    return [];
  }

  try {
    let parsed: unknown;
    try {
      const storeStat = fs.fstatSync(fd);
      if (!storeStat.isFile()) {
        issues.push({
          code: "store_unreadable",
          message: `${target.storePath}: not a regular file`,
        });
        return [];
      }
      // Fail closed if the pinned file grows past the size validated above.
      const raw = readFileDescriptorBoundedSync(fd, storeStat.size).toString("utf-8");
      parsed = JSON.parse(raw);
    } catch (err) {
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
  } finally {
    fs.closeSync(fd);
  }
}

function isLegacySessionRecordOwnedByTarget(
  cfg: OpenClawConfig,
  target: SessionStoreTarget,
  sessionKey: string,
): boolean {
  if (target.sqlitePath) {
    const parsed = parseAgentSessionKey(sessionKey);
    const ownerAgentId =
      parsed?.agentId ??
      cfg.agents?.defaults?.sessionStore?.agentId?.trim() ??
      tryResolveLegacyCompatibilityAgentId(cfg);
    return ownerAgentId
      ? normalizeAgentId(ownerAgentId) === normalizeAgentId(target.agentId)
      : false;
  }
  const ownerAgentId = resolveStoredSessionOwnerAgentId({
    cfg,
    agentId: target.agentId,
    sessionKey,
  });
  return ownerAgentId
    ? ownerAgentId === target.agentId
    : target.agentId === tryResolveDefaultAgentId(cfg);
}

function shouldFilterLegacySessionRecordsByTarget(target: SessionStoreTarget): boolean {
  // Filtering depends on whether the authored store path encodes an owner,
  // not on the configured/default owner selected for its SQLite target.
  return !resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).agentId;
}

function resolveLegacyTranscriptPath(
  target: SessionStoreTarget,
  entry: SessionEntry,
): string | undefined {
  const legacySessionFile = (entry as { sessionFile?: string }).sessionFile;
  if (parseSqliteSessionFileMarker(legacySessionFile)) {
    return undefined;
  }
  const sessionsDir = path.dirname(target.storePath);
  const relocatedPath = legacySessionFile?.trim()
    ? path.join(sessionsDir, path.basename(legacySessionFile))
    : undefined;
  let defaultPath: string;
  try {
    defaultPath = resolveSessionFilePathCore(entry.sessionId, entry, {
      agentId: target.agentId,
      sessionsDir,
    });
  } catch (error) {
    if (!relocatedPath) {
      throw error;
    }
    defaultPath = relocatedPath;
  }
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  if (relocatedPath && fs.existsSync(relocatedPath)) {
    return relocatedPath;
  }
  return relocatedPath ? defaultPath : undefined;
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
  return report.issues.filter((issue) => !isSessionSqliteMigrationWarning(issue)).length;
}

async function importLegacySessionRecords(
  target: SessionStoreTarget,
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const importedTranscriptSources = new Set<string>();
  const existingSnapshot = readOnlySqliteValidationSnapshot(target);
  for (let offset = 0; offset < records.length; offset += SESSION_IMPORT_BATCH_SIZE) {
    const pending = records.slice(offset, offset + SESSION_IMPORT_BATCH_SIZE).flatMap((record) => {
      const prepared = prepareLegacySessionImport(
        target,
        record,
        report,
        importedTranscriptSources,
        existingSnapshot.ok ? existingSnapshot.snapshot : undefined,
      );
      return prepared ? [prepared] : [];
    });
    const imported = await importSqliteSessionRowsBatch(pending.map((entry) => entry.params));
    report.importedEntries += imported.length;
    report.importedTranscriptEvents += imported.reduce(
      (total, result) => total + result.transcriptEvents,
      0,
    );
    report.issues.push(...pending.flatMap((entry) => (entry.issue ? [entry.issue] : [])));
  }
}

function prepareLegacySessionImport(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  importedTranscriptSources: Set<string>,
  existingSnapshot: ReadOnlySqliteValidationSnapshot | undefined,
) {
  const transcriptSourceKey = record.transcriptPath
    ? `${record.entry.sessionId}\0${record.transcriptPath}`
    : undefined;
  const transcriptFingerprint =
    transcriptSourceKey !== undefined &&
    !importedTranscriptSources.has(transcriptSourceKey) &&
    record.transcriptPath &&
    fs.existsSync(record.transcriptPath)
      ? readTranscriptFingerprint(record.transcriptPath)
      : undefined;
  const result = countTranscriptEvents(record);
  const transcriptMtimeMs = readLegacyTranscriptMtimeMs(record);
  const params = {
    allowMalformedRowRepair: true,
    agentId: target.agentId,
    entry: record.entry,
    preserveExactStoredKey: true,
    sessionKey: record.sessionKey,
    storePath: target.sqlitePath ?? target.storePath,
  };
  if (result.status === "missing") {
    if (markAlreadyMigratedTranscript(record, report, existingSnapshot)) {
      return undefined;
    }
    return {
      issue: {
        code: "transcript_missing",
        message: `Transcript file is missing: ${record.transcriptPath}`,
        sessionKey: record.sessionKey,
      },
      params,
    };
  }
  if (transcriptSourceKey) {
    importedTranscriptSources.add(transcriptSourceKey);
  }
  return {
    ...(result.status === "malformed"
      ? {
          issue: {
            code: "transcript_malformed" as const,
            message: result.message,
            sessionKey: record.sessionKey,
          },
        }
      : {}),
    params: {
      ...params,
      ...(record.transcriptPath && transcriptFingerprint
        ? {
            readTranscriptEvents: createTranscriptEventReader(
              record.transcriptPath,
              record.entry.sessionId,
              result.status === "malformed",
              transcriptFingerprint,
            ),
          }
        : {}),
      ...(transcriptMtimeMs !== undefined ? { transcriptMtimeMs } : {}),
    },
  };
}

function markAlreadyMigratedTranscript(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
): boolean {
  const migratedEvents = countAlreadyMigratedTranscriptEventsForImport(snapshot, record);
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
  if (records.length === 0) {
    return true;
  }
  const issueCountBeforeValidation = report.issues.length;
  const validation = readOnlySqliteValidationSnapshot(target);
  if (!validation.ok) {
    report.issues.push({
      code: "sqlite_read_failed",
      message: `SQLite validation read failed: ${String(validation.error)}`,
    });
    return false;
  }
  for (const record of records) {
    validateImportedRecordBeforeArchive(record, report, validation.snapshot);
  }
  return report.issues.length === issueCountBeforeValidation;
}

function validateImportedRecordBeforeArchive(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot,
): void {
  const normalizedKey = record.sessionKey;
  const sqliteSessionId = snapshot.sessionIdsBySessionKey.get(normalizedKey);
  if (!sqliteSessionId) {
    report.issues.push({
      code: "sqlite_entry_missing",
      message: `SQLite entry is missing for ${normalizedKey}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (sqliteSessionId !== record.entry.sessionId) {
    report.issues.push({
      code: "sqlite_entry_mismatch",
      message: `SQLite sessionId ${sqliteSessionId} does not match ${record.entry.sessionId}.`,
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
  const sqliteEvents = snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
  if (sqliteEvents < result.events) {
    report.issues.push({
      code: "sqlite_transcript_count_mismatch",
      message: `SQLite transcript has ${sqliteEvents} events; source has ${result.events}.`,
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
  const reservedArchivePaths = new Set<string>();
  const plannedArchives: Array<{
    moves: SessionSqliteMigrationMove[];
    record: LegacySessionRecord;
  }> = [];
  for (const record of records) {
    if (!record.transcriptPath || archivedTranscriptPaths.has(record.transcriptPath)) {
      continue;
    }
    archivedTranscriptPaths.add(record.transcriptPath);
    if (!fs.existsSync(record.transcriptPath)) {
      continue;
    }
    try {
      plannedArchives.push({
        moves: planImportedTranscriptArtifactsToArchive(
          target,
          record.sessionKey,
          record.transcriptPath,
          reservedArchivePaths,
        ),
        record,
      });
    } catch (err) {
      report.issues.push({
        code: "transcript_archive_failed",
        message: `${record.transcriptPath}: ${String(err)}`,
        sessionKey: record.sessionKey,
      });
    }
  }
  const migrationTarget = createMigrationTargetInput(target);
  recordPlannedMigrationMoves(
    activeRun,
    migrationTarget,
    plannedArchives.flatMap((archive) => archive.moves),
  );
  const completedMoves: SessionSqliteMigrationMove[] = [];
  for (const { moves, record } of plannedArchives) {
    try {
      const archivePaths: string[] = [];
      for (const move of moves) {
        assertSafeSessionSqliteMigrationMove(move, migrationTarget);
        fs.renameSync(move.sourcePath, move.archivePath);
        archivePaths.push(move.archivePath);
        completedMoves.push(move);
      }
      report.archivedTranscriptFiles.push(...archivePaths);
    } catch (err) {
      report.issues.push({
        code: "transcript_archive_failed",
        message: `${record.transcriptPath}: ${String(err)}`,
        sessionKey: record.sessionKey,
      });
    }
  }
  recordCompletedMigrationMoves(activeRun, migrationTarget, completedMoves);
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
  recordPlannedMigrationMoves(activeRun, createMigrationTargetInput(target), [move]);
  recordCompletedMigrationMoves(activeRun, createMigrationTargetInput(target), [move]);
}

function validateLegacySessionRecords(
  target: SessionStoreTarget,
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
): void {
  const validation = readOnlySqliteValidationSnapshot(target);
  if (!validation.ok) {
    report.issues.push({
      code: "sqlite_read_failed",
      message: `SQLite validation read failed: ${String(validation.error)}`,
    });
    return;
  }
  for (const record of records) {
    validateLegacySessionRecord(record, report, validation.snapshot);
  }
}

function validateLegacySessionRecord(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot,
): void {
  const normalizedKey = normalizeStoreSessionKey(record.sessionKey);
  const sqliteSessionId = snapshot.sessionIdsBySessionKey.get(normalizedKey);
  if (!sqliteSessionId) {
    report.issues.push({
      code: "sqlite_entry_missing",
      message: `SQLite entry is missing for ${normalizedKey}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (sqliteSessionId !== record.entry.sessionId) {
    report.issues.push({
      code: "sqlite_entry_mismatch",
      message: `SQLite sessionId ${sqliteSessionId} does not match ${record.entry.sessionId}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  report.validatedEntries += 1;
  validateTranscriptEventCount(record, report, snapshot);
}

function validateTranscriptEventCount(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot,
): void {
  const result = countTranscriptEvents(record);
  if (result.status === "missing") {
    const migratedEvents = countAlreadyMigratedTranscriptEventsForValidate(snapshot, record);
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
  const sqliteEvents = snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
  if (sqliteEvents !== result.events) {
    report.issues.push({
      code: "sqlite_transcript_count_mismatch",
      message: `SQLite transcript has ${sqliteEvents} events; source has ${result.events}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  report.validatedTranscriptEvents += sqliteEvents;
}

function hasSessionIssue(
  report: DoctorSessionSqliteTargetReport,
  code: string,
  sessionKey: string,
): boolean {
  return report.issues.some((issue) => issue.code === code && issue.sessionKey === sessionKey);
}

function countAlreadyMigratedTranscriptEventsForImport(
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
  record: LegacySessionRecord,
): number | undefined {
  if (!snapshot) {
    return undefined;
  }
  const normalizedKey = record.sessionKey;
  if (snapshot.sessionIdsBySessionKey.get(normalizedKey) !== record.entry.sessionId) {
    return undefined;
  }
  return snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
}

function countAlreadyMigratedTranscriptEventsForValidate(
  snapshot: ReadOnlySqliteValidationSnapshot,
  record: LegacySessionRecord,
): number | undefined {
  const normalizedKey = normalizeStoreSessionKey(record.sessionKey);
  if (snapshot.sessionIdsBySessionKey.get(normalizedKey) !== record.entry.sessionId) {
    return undefined;
  }
  return snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
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
  const result = scanReadOnlySqliteActiveTranscriptFiles(
    target,
    (sessionKey, sessionId, sessionFile) => {
      const transcriptPath = resolveActiveSqliteTranscriptFile(target, {
        ...(sessionFile ? { sessionFile } : {}),
        sessionId,
      });
      if (transcriptPath) {
        report.issues.push({
          code: "active_sqlite_transcript_jsonl",
          message: `SQLite-backed session still has an active JSONL transcript file: ${transcriptPath}`,
          sessionKey,
        });
      }
    },
  );
  if (!result.ok) {
    report.issues.push({
      code: "sqlite_active_transcript_scan_failed",
      message: `Could not scan SQLite-backed sessions for active JSONL transcript files: ${String(result.error)}`,
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

async function compactSqliteDatabase(
  target: SessionStoreTarget,
  report: DoctorSessionSqliteTargetReport,
  options: {
    env?: NodeJS.ProcessEnv;
    operation?: "import-finalize";
  } = {},
): Promise<void> {
  try {
    if (options.operation === "import-finalize") {
      closeOpenClawAgentDatabaseByPath(resolveTargetSqlitePath(target));
    }
    report.compact = await compactDoctorSessionSqliteTarget(target, options);
  } catch (err) {
    report.issues.push({
      code: "sqlite_compact_failed",
      message: `SQLite database compact failed: ${String(err)}`,
    });
  }
}

function resolveActiveSqliteTranscriptFile(
  target: SessionStoreTarget,
  entry: { sessionFile?: string; sessionId: string },
): string | undefined {
  let transcriptPath: string;
  try {
    transcriptPath = resolveSessionFilePathCore(entry.sessionId, entry, {
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

function planImportedTranscriptArtifactsToArchive(
  target: SessionStoreTarget,
  sessionKey: string,
  transcriptPath: string,
  reservedArchivePaths: Set<string>,
): SessionSqliteMigrationMove[] {
  const moves: SessionSqliteMigrationMove[] = [];
  const addMove = (sourcePathRaw: string, kind: SessionSqliteMigrationMoveKind) => {
    const move = planSessionJsonlArchiveMove({
      archiveKey: sessionKey,
      baseNameRaw: path.basename(sourcePathRaw),
      kind,
      reservedArchivePaths,
      sessionKey,
      sourcePathRaw,
      target,
    });
    reservedArchivePaths.add(move.archivePath);
    moves.push(move);
  };
  addMove(transcriptPath, "transcript");
  const trajectoryPath = resolveTrajectoryPath(transcriptPath);
  if (trajectoryPath && fs.existsSync(trajectoryPath)) {
    addMove(trajectoryPath, "trajectory");
  }
  const trajectoryPointerPath = resolveTrajectoryPointerPath(transcriptPath);
  if (trajectoryPointerPath && fs.existsSync(trajectoryPointerPath)) {
    addMove(trajectoryPointerPath, "trajectory");
  }
  return moves;
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
  recordPlannedMigrationMoves(params.activeRun, migrationTarget, [move]);
  assertSafeSessionSqliteMigrationMove(move, migrationTarget);
  fs.renameSync(move.sourcePath, move.archivePath);
  recordCompletedMigrationMoves(params.activeRun, migrationTarget, [move]);
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
  const sum = (value: (target: DoctorSessionSqliteTargetReport) => number) =>
    sumDoctorSessionSqliteTargets(targets, value);
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
    totals: createDoctorSessionSqliteTotals(targets, {
      archivedLegacyStoreFiles: sum((target) => target.archivedLegacyStoreFiles?.length ?? 0),
      archivedTranscriptFiles: sum((target) => target.archivedTranscriptFiles.length),
      archivedUnreferencedJsonlFiles: sum((target) => target.archivedUnreferencedJsonlFiles.length),
      importedEntries: sum((target) => target.importedEntries),
      importedTranscriptEvents: sum((target) => target.importedTranscriptEvents),
      legacyEntries: sum((target) => target.legacyEntries),
      reclaimedBytes: sum((target) => target.compact?.reclaimedBytes ?? 0),
      unreferencedJsonlFiles: sum((target) => target.unreferencedJsonlFiles.length),
      validatedEntries: sum((target) => target.validatedEntries),
      validatedTranscriptEvents: sum((target) => target.validatedTranscriptEvents),
    }),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
