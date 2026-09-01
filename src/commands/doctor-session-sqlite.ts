import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveStateDir } from "../config/paths.js";
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
import { formatErrorMessage } from "../infra/errors.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeLegacySessionEntryDelivery as normalizeSessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { migrateLegacySessionCreator } from "../state/creator-namespace-migration.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  moveMigrationArtifact,
  type MigrationArtifactIdentity,
} from "./doctor-session-sqlite-artifact.js";
import { compactDoctorSessionSqliteTarget } from "./doctor-session-sqlite-compact.js";
import { writeSessionSqliteMigrationFailureReports } from "./doctor-session-sqlite-failure.js";
import {
  assertSafeSessionSqliteMigrationDirectory,
  assertSafeSessionSqliteMigrationMove,
  canonicalMigrationFilePath,
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
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
  resolveLegacyTranscriptPaths,
  resolveTargetSqlitePath,
  scanReadOnlySqliteActiveTranscriptFiles,
  type ReadOnlySqliteValidationSnapshot,
} from "./doctor-session-sqlite-readers.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import { restoreDoctorSessionSqliteTargets } from "./doctor-session-sqlite-restore-report.js";
import { reconcileSessionSqliteMigrationPublications } from "./doctor-session-sqlite-restore.js";
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
  transcriptDependencies: string[];
  recovery?: { complete: boolean; repaired: boolean; events: number };
  sourceFingerprint?: ReturnType<typeof readTranscriptFingerprint>;
};

type LegacyArchiveTarget = {
  target: SessionSqliteMigrationTargetInput;
  report: DoctorSessionSqliteTargetReport;
  validated: boolean;
  records: Array<Omit<LegacySessionRecord, "entry"> & { sessionId: string }>;
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
  if (options.mode === "import") {
    await reconcileSessionSqliteMigrationPublications({
      env,
      trustedTargets: targets.map(createMigrationTargetInput),
    });
  }
  const activeRun =
    options.mode === "import" && targets.length > 0
      ? createSessionSqliteMigrationRun(env, targets.map(createMigrationTargetInput))
      : undefined;
  const coverage =
    options.mode === "import" ? gatherLegacyArchiveCoverage(cfg, env, targets) : undefined;
  const reports: DoctorSessionSqliteTargetReport[] = [];
  const archiveTargets: LegacyArchiveTarget[] = [];
  for (const target of targets) {
    reports.push(
      await inspectOrMigrateTarget({
        activeRun,
        archiveTargets,
        cfg,
        env,
        mode: options.mode,
        target,
      }),
    );
  }
  if (activeRun && coverage) {
    await archiveLegacyArtifacts(archiveTargets, coverage, activeRun);
    for (const [index, target] of targets.entries()) {
      const report = reports[index]!;
      appendActiveSqliteTranscriptFileIssues(target, report);
      updateMigrationManifestTarget(activeRun, createMigrationTargetInput(target), report.issues);
    }
    await archiveImportedLegacySessionStores(archiveTargets, activeRun, coverage);
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

/** Called only under the public maintenance lock, before its strict alias recheck. */
export async function reconcileDoctorSessionSqlitePublication(
  options: DoctorSessionSqliteOptions,
  sourcePath: string,
): Promise<void> {
  const env = options.env ?? process.env;
  const cfg = resolveDoctorSessionSqliteConfig(options);
  const targets = resolveDoctorSessionSqliteTargets({ ...options, cfg, env });
  assertDoctorSqliteMaintenancePathsNotAliased(
    `session SQLite ${options.mode}`,
    resolveDoctorSessionSqliteMaintenancePaths(targets),
    resolveDoctorSessionSqliteMaintenanceRoots(targets, env),
  );
  await reconcileSessionSqliteMigrationPublications({
    env,
    sourcePath,
    trustedTargets: targets.map(createMigrationTargetInput),
  });
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
  archiveTargets?: LegacyArchiveTarget[];
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
  let validationPassed = false;
  if (params.mode === "import" && blockingIssueCount(report) === 0) {
    validationPassed = validateImportedTargetBeforeArchive(params.target, records, report);
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      report.issues,
      {
        validationBeforeArchive: validationPassed ? "passed" : "failed",
      },
    );
    if (validationPassed) {
      // Finalization enables incremental vacuum where needed and releases free pages.
      await compactSqliteDatabase(params.target, report, {
        env: params.env,
        operation: "import-finalize",
      });
    }
  }
  if (params.mode === "import") {
    // Retain importer outcomes, not entry or transcript payloads, until every owner finishes.
    params.archiveTargets?.push({
      target: createMigrationTargetInput(params.target),
      report,
      validated: validationPassed,
      records: records.map(({ entry, ...record }) =>
        Object.assign(record, { sessionId: entry.sessionId }),
      ),
    });
  }
  report.sqliteEntries = readSqliteEntryCount(params.target);
  if (params.mode !== "import") {
    appendActiveSqliteTranscriptFileIssues(params.target, report);
  }
  updateMigrationManifestTarget(
    params.activeRun,
    createMigrationTargetInput(params.target),
    report.issues,
  );
  return report;
}

function gatherLegacyArchiveCoverage(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  targets: readonly SessionStoreTarget[],
) {
  const selectedStorePaths = new Set<string>();
  const referencedPaths = new Set<string>();
  const retainedPaths = new Set<string>();
  const incompleteDirectories = new Set<string>();
  const retainedDirectories = new Set<string>();
  const indexIdentities = new Map<string, MigrationArtifactIdentity>();
  const targetsByStore = new Map<string, SessionStoreTarget[]>();
  for (const target of targets) {
    const storePath = canonicalMigrationFilePath(target.storePath);
    targetsByStore.set(storePath, [...(targetsByStore.get(storePath) ?? []), target]);
  }
  const directories = new Set([...targetsByStore.keys()].map((store) => path.dirname(store)));
  const knownStores = new Map(
    [...resolveAllAgentSessionStoreCandidateTargetsSync(cfg, { env }), ...targets].map((target) => [
      canonicalMigrationFilePath(target.storePath),
      target,
    ]),
  );
  // Only configured/discovered indexes in selected directories can contribute references.
  // An unreadable index never proves that the directory's remaining files are unreferenced.
  for (const [storePath, target] of knownStores) {
    if (
      storePath.endsWith(".sqlite") ||
      !directories.has(path.dirname(storePath)) ||
      !fs.existsSync(storePath)
    ) {
      continue;
    }
    const storeTargets = targetsByStore.get(storePath) ?? [];
    const issues: DoctorSessionSqliteIssue[] = [];
    let records: LegacySessionRecord[];
    try {
      // Aliased or unreadable known indexes cannot establish complete reference coverage.
      assertSafeSessionSqliteMigrationDirectory(path.dirname(storePath));
      indexIdentities.set(storePath, readMigrationArtifactIdentity(storePath));
      records = readLegacySessionRecords(target, issues);
    } catch (error) {
      if (storeTargets.length > 0) {
        throw error;
      }
      incompleteDirectories.add(path.dirname(storePath));
      retainedDirectories.add(path.dirname(storePath));
      continue;
    }
    const keys = [
      ...records.map((record) => record.sessionKey),
      ...issues.flatMap((issue) => (issue.sessionKey ? [issue.sessionKey] : [])),
    ];
    const selected =
      storeTargets.length > 0 &&
      issues.every(isSessionSqliteMigrationWarning) &&
      keys.every((sessionKey) =>
        storeTargets.some(
          (candidate) =>
            !shouldFilterLegacySessionRecordsByTarget(candidate) ||
            isLegacySessionRecordOwnedByTarget(cfg, candidate, sessionKey),
        ),
      );
    if (issues.length > 0) {
      incompleteDirectories.add(path.dirname(storePath));
      if (!selected) {
        retainedDirectories.add(path.dirname(storePath));
      }
    }
    if (selected) {
      selectedStorePaths.add(storePath);
    }
    for (const record of records) {
      if (!record.transcriptPath) {
        continue;
      }
      for (const source of [
        record.transcriptPath,
        resolveTrajectoryPath(record.transcriptPath),
        resolveTrajectoryPointerPath(record.transcriptPath),
      ]) {
        if (!source) {
          continue;
        }
        const canonical = canonicalMigrationFilePath(source);
        referencedPaths.add(canonical);
        if (!selected) {
          retainedPaths.add(canonical);
        }
      }
    }
  }
  return {
    selectedStorePaths,
    referencedPaths,
    retainedPaths,
    incompleteDirectories,
    retainedDirectories,
    indexIdentities,
  };
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
      const transcript = resolveLegacyTranscriptPaths(target, value);
      records.push({
        // Import is the migration boundary: repair legacy delivery/route shapes
        // here because the SQLite runtime read path assumes canonical entries.
        entry: migrateLegacySessionCreator(normalizeSessionEntryDelivery(value)),
        sessionKey,
        ...transcript,
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
    for (const [index, result] of imported.entries()) {
      const sessionKey = pending[index]?.params.sessionKey;
      const record = records.find((candidate) => candidate.sessionKey === sessionKey);
      if (record && result.recovery) {
        record.recovery = result.recovery;
      }
    }
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
  record.sourceFingerprint = transcriptFingerprint;
  const result = countTranscriptEvents(record);
  const transcriptMtimeMs = readLegacyTranscriptMtimeMs(record);
  const params = {
    allowMalformedRowRepair: true,
    repairLegacyTranscript: true,
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
  const expectedEvents = record.recovery?.events ?? result.events;
  if (sqliteEvents < expectedEvents) {
    report.issues.push({
      code: "sqlite_transcript_count_mismatch",
      message: `SQLite transcript has ${sqliteEvents} events; verified import expects ${expectedEvents}.`,
      sessionKey: record.sessionKey,
    });
  }
}

async function archiveLegacyArtifacts(
  owners: readonly LegacyArchiveTarget[],
  coverage: ReturnType<typeof gatherLegacyArchiveCoverage>,
  activeRun: ActiveSessionSqliteMigrationRun,
): Promise<void> {
  const {
    selectedStorePaths,
    referencedPaths,
    retainedPaths,
    incompleteDirectories,
    retainedDirectories,
  } = coverage;
  const references = new Map<
    string,
    Array<{ owner: LegacyArchiveTarget; record: LegacyArchiveTarget["records"][number] }>
  >();
  for (const owner of owners) {
    if (!owner.validated || blockingIssueCount(owner.report) > 0) {
      selectedStorePaths.delete(owner.target.storePath);
    }
    for (const record of owner.records) {
      if (!record.transcriptPath) {
        continue;
      }
      const source = canonicalMigrationFilePath(record.transcriptPath);
      references.set(source, [...(references.get(source) ?? []), { owner, record }]);
    }
  }
  // A retained index needs all its originals. Propagate through shared sources before planning,
  // so a direct retry cannot strand a sibling archive without its index.
  const retainedSources = [...references]
    .filter(
      ([source, refs]) =>
        retainedPaths.has(source) ||
        retainedDirectories.has(path.dirname(source)) ||
        refs.some(({ owner }) => !selectedStorePaths.has(owner.target.storePath)),
    )
    .map(([source]) => source);
  for (const source of retainedSources) {
    for (const file of [
      source,
      resolveTrajectoryPath(source),
      resolveTrajectoryPointerPath(source),
    ]) {
      if (file) {
        retainedPaths.add(file);
      }
    }
    for (const { owner } of references.get(source) ?? []) {
      const storePath = owner.target.storePath;
      if (!selectedStorePaths.delete(storePath)) {
        continue;
      }
      for (const sibling of owners.filter((item) => item.target.storePath === storePath)) {
        for (const record of sibling.records) {
          if (!record.transcriptPath) {
            continue;
          }
          const siblingSource = canonicalMigrationFilePath(record.transcriptPath);
          if (!retainedPaths.has(siblingSource)) {
            retainedPaths.add(siblingSource);
            retainedSources.push(siblingSource);
          }
        }
      }
    }
  }
  const reservedArchivePaths = new Set<string>();
  const planned = new Map<
    string,
    { move: SessionSqliteMigrationMove; owners: Map<LegacyArchiveTarget, string | undefined> }
  >();
  const recordFailure = (
    owner: LegacyArchiveTarget,
    source: string,
    error: unknown,
    unreferenced = false,
  ) => {
    owner.report.issues.push({
      code: unreferenced ? "unreferenced_jsonl_archive_failed" : "transcript_archive_failed",
      message: `${source}: ${formatErrorMessage(error)}`,
    });
  };
  for (const [source, refs] of references) {
    const first = refs[0]!;
    if (!fs.existsSync(source)) {
      // Only initially missing sources may be skipped. Losing an admitted original must
      // protect every referencing index and its remaining recovery dependencies.
      if (refs.some(({ record }) => record.sourceFingerprint)) {
        for (const owner of new Set(refs.map((ref) => ref.owner))) {
          recordFailure(owner, source, "Imported transcript disappeared before archival");
        }
      }
      continue;
    }
    if (retainedPaths.has(source) || retainedDirectories.has(path.dirname(source))) {
      for (const { owner, record } of refs) {
        if (blockingIssueCount(owner.report) === 0) {
          owner.report.issues.push({
            code: "transcript_archive_deferred",
            message: `${source}: retaining the original for an incomplete or unselected importing owner; rerun import for all known owners after resolving their index/import issues.`,
            sessionKey: record.sessionKey,
          });
        }
      }
      continue;
    }
    try {
      const moves = planImportedTranscriptArtifactsToArchive(
        first.owner.target,
        first.record.sessionKey,
        source,
        reservedArchivePaths,
      );
      // Same-session aliases reuse the actual importer evidence only within their validated target.
      const imports = refs.map(({ owner, record }) =>
        record.sourceFingerprint
          ? record
          : refs.find(
              (ref) =>
                ref.owner === owner &&
                ref.record.sessionId === record.sessionId &&
                ref.record.sourceFingerprint,
            )?.record,
      );
      const fingerprints = imports.flatMap((record) =>
        record?.sourceFingerprint ? [record.sourceFingerprint] : [],
      );
      const fingerprint = fingerprints[0];
      if (
        fingerprint &&
        fingerprints.some((current) =>
          (["ctimeNs", "dev", "ino", "mtimeNs", "size"] as const).some(
            (key) => current[key] !== fingerprint[key],
          ),
        )
      ) {
        throw new Error("Transcript changed between imports; retaining the unverified original");
      }
      const complete =
        !incompleteDirectories.has(path.dirname(source)) &&
        imports.every((record) => record?.sourceFingerprint && record.recovery?.complete) &&
        refs.every(
          ({ owner, record }) =>
            !hasSessionIssue(owner.report, "transcript_malformed", record.sessionKey),
        );
      for (const move of moves) {
        if (retainedPaths.has(move.sourcePath)) {
          throw new Error("Artifact is required by an incomplete importing owner");
        }
        move.artifact = {
          identity: readMigrationArtifactIdentity(
            move.sourcePath,
            1n,
            move.kind === "transcript" ? fingerprint : undefined,
          ),
          classification:
            complete && move.kind === "transcript"
              ? imports.some((record) => record?.recovery?.repaired)
                ? "repair-original"
                : "imported"
              : "protected",
          reason:
            complete && move.kind === "transcript"
              ? "verified-import-original"
              : "unimported-or-unknown-history",
          dependencies: [],
          disposal: { state: "retained" },
        };
        const existing = planned.get(move.sourcePath);
        if (existing) {
          if (move.artifact.classification === "protected") {
            existing.move.artifact = move.artifact;
          }
          for (const ref of refs) {
            existing.owners.set(ref.owner, ref.record.sessionKey);
          }
        } else {
          planned.set(move.sourcePath, {
            move,
            owners: new Map(refs.map((ref) => [ref.owner, ref.record.sessionKey])),
          });
        }
      }
    } catch (error) {
      for (const owner of new Set(refs.map((ref) => ref.owner))) {
        recordFailure(owner, source, error);
      }
    }
  }
  // Gather all indexed sources and plans before sweeping any directory; another custom index
  // may own a file even when its importer failed or was not selected for this run.
  for (const owner of owners) {
    const storePath = owner.target.storePath;
    if (
      !selectedStorePaths.has(storePath) ||
      blockingIssueCount(owner.report) > 0 ||
      incompleteDirectories.has(path.dirname(storePath))
    ) {
      continue;
    }
    for (const source of listUnreferencedJsonlFiles(storePath, [
      ...referencedPaths,
      ...planned.keys(),
    ])) {
      try {
        const move = planSessionJsonlArchiveMove({
          archiveKey: "archive-tier",
          baseNameRaw: path.basename(source),
          kind: "unreferenced-jsonl",
          reservedArchivePaths,
          sourcePathRaw: source,
          target: owner.target,
        });
        move.artifact = {
          identity: readMigrationArtifactIdentity(source),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        };
        reservedArchivePaths.add(move.archivePath);
        planned.set(source, { move, owners: new Map([[owner, undefined]]) });
      } catch (error) {
        recordFailure(owner, source, error, true);
      }
    }
  }
  const movesForOwner = (owner: LegacyArchiveTarget) =>
    [...planned.values()]
      .filter((item) => item.owners.has(owner))
      .map(({ move, owners: refs }) => Object.assign({}, move, { sessionKey: refs.get(owner) }));
  // Every referencing target gets its own session key and shared mapping before publication.
  for (const owner of owners) {
    recordPlannedMigrationMoves(activeRun, owner.target, movesForOwner(owner));
  }
  const completed = new Set<string>();
  for (const { move, owners: referencingOwners } of planned.values()) {
    try {
      for (const owner of referencingOwners.keys()) {
        assertSafeSessionSqliteMigrationMove(move, owner.target);
      }
      await moveMigrationArtifact(move.sourcePath, move.archivePath, move.artifact!.identity);
      completed.add(move.sourcePath);
      const report = [...referencingOwners.keys()][0]!.report;
      (move.kind === "unreferenced-jsonl"
        ? report.archivedUnreferencedJsonlFiles
        : report.archivedTranscriptFiles
      ).push(move.archivePath);
    } catch (error) {
      for (const owner of referencingOwners.keys()) {
        recordFailure(owner, move.sourcePath, error, move.kind === "unreferenced-jsonl");
      }
    }
  }
  for (const owner of owners) {
    recordCompletedMigrationMoves(
      activeRun,
      owner.target,
      movesForOwner(owner).filter((move) => completed.has(move.sourcePath)),
    );
    owner.report.unreferencedJsonlFiles = listUnreferencedJsonlFiles(owner.target.storePath, [
      ...referencedPaths,
    ]);
  }
}

async function archiveImportedLegacySessionStores(
  owners: readonly LegacyArchiveTarget[],
  activeRun: ActiveSessionSqliteMigrationRun,
  coverage: ReturnType<typeof gatherLegacyArchiveCoverage>,
): Promise<void> {
  const byStore = new Map<string, LegacyArchiveTarget[]>();
  for (const owner of owners) {
    const storePath = owner.target.storePath;
    byStore.set(storePath, [...(byStore.get(storePath) ?? []), owner]);
  }
  for (const [storePath, entries] of byStore) {
    if (
      !coverage.selectedStorePaths.has(storePath) ||
      entries.some(({ report }) => blockingIssueCount(report) > 0)
    ) {
      continue;
    }
    const first = entries[0]!;
    let publicationPlanned = false;
    try {
      const expected = coverage.indexIdentities.get(storePath);
      if (!expected || !sameMigrationArtifact(readMigrationArtifactIdentity(storePath), expected)) {
        throw new Error("Session index changed after import; retaining the unverified original");
      }
      const move = planSessionJsonlArchiveMove({
        archiveKey: "legacy-store",
        baseNameRaw: path.basename(storePath),
        kind: "legacy-store",
        sourcePathRaw: storePath,
        target: first.target,
      });
      const manifestTargets = activeRun.manifest.targets.filter(
        (target) => target.storePath === storePath,
      );
      const transcripts = manifestTargets.flatMap((target) =>
        target.plannedMoves.filter((item) => item.kind === "transcript"),
      );
      const complete =
        entries.every(({ validated, report }) => validated && report.issues.length === 0) &&
        transcripts.every((item) => item.artifact?.classification !== "protected");
      const dependencies = entries
        .flatMap(({ records }) => records.flatMap((record) => record.transcriptDependencies))
        .map(canonicalMigrationFilePath);
      move.artifact = {
        identity: expected,
        classification: complete ? "imported" : "protected",
        reason: complete ? "verified-index-import" : "incomplete-index-import",
        dependencies: [...new Set(dependencies)],
        disposal: { state: "retained" },
      };
      for (const { target } of entries) {
        recordPlannedMigrationMoves(activeRun, target, [move]);
        assertSafeSessionSqliteMigrationMove(move, target);
      }
      publicationPlanned = true;
      await moveMigrationArtifact(move.sourcePath, move.archivePath, expected);
      for (const { target } of entries) {
        recordCompletedMigrationMoves(activeRun, target, [move]);
      }
      first.report.archivedLegacyStoreFiles!.push(move.archivePath);
    } catch (error) {
      for (const { report, target } of entries) {
        report.issues.push({
          code: "legacy_store_archive_failed",
          message: `${storePath}: ${formatErrorMessage(error)}`,
        });
        // A recorded index plan already protects its dependencies and can reconcile on retry.
        // Earlier failures have no artifact record, so retain that failure on the owner instead.
        if (!publicationPlanned) {
          updateMigrationManifestTarget(activeRun, target, report.issues);
        }
      }
    }
  }
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
