import fs from "node:fs";
import { listAgentIds } from "../agents/agent-scope.js";
import {
  isSessionSqliteMigrationWarning,
  type DoctorSessionSqliteIssue,
  type DoctorSessionSqliteReport,
  type DoctorSessionSqliteRestoreReport,
} from "../commands/doctor-session-sqlite-types.js";
import {
  listSessionEntriesReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  runSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasProjectedAgentRunForSession } from "../infra/agent-run-registry.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";

const INTERRUPTED_SUBAGENT_REASON =
  "subagent run was interrupted before a terminal lifecycle event was persisted";

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type SessionSqliteStartupImportRunner = (params: {
  allAgents: true;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: "import";
}) => Promise<DoctorSessionSqliteReport>;

type SessionSqliteStartupRestoreRunner = (params: {
  manifestPath: string;
  trustedTargets: Array<{ agentId: string; sqlitePath: string; storePath: string }>;
}) => DoctorSessionSqliteRestoreReport;

type SessionSqliteStartupFailureReportWriter = (
  manifestPath: string,
  params: { reason: string },
) => { jsonPath: string; markdownPath: string };

type SessionSqliteDatabaseExists = (params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
}) => boolean;

type SessionMigrationDeps = Parameters<typeof runSessionStartupMigration>[0]["deps"] & {
  hasProjectedAgentRunForSession?: typeof hasProjectedAgentRunForSession;
  processStartedAtMs?: number;
  readActiveGatewayLockIdentity?: typeof readActiveGatewayLockIdentity;
  reconcileSessionTranscriptIndexes?: typeof import("../config/sessions/session-transcript-reconcile.js").reconcileSessionTranscriptIndexes;
  restoreSessionSqliteMigrationRun?: SessionSqliteStartupRestoreRunner;
  runDoctorSessionSqlite?: SessionSqliteStartupImportRunner;
  sessionSqliteDatabaseExists?: SessionSqliteDatabaseExists;
  writeSessionSqliteMigrationFailureReports?: SessionSqliteStartupFailureReportWriter;
};

/**
 * Run session migrations at gateway startup before runtime session access.
 *
 * Orphan-key cleanup remains best-effort. Full SQLite import is blocking
 * for hot legacy session issues because runtime no longer falls back to JSONL.
 */
export async function runStartupSessionMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  const hasSessionStores = await runSessionStartupMigration(params);
  if (hasSessionStores) {
    await runStartupSessionSqliteImport(params);
    await reconcileInterruptedSubagentSessions(params);
  }
  await reconcileStartupSessionTranscriptIndexes(params);
}

async function reconcileInterruptedSubagentSessions(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  const env = params.env ?? process.env;
  const readGatewayLock =
    params.deps?.readActiveGatewayLockIdentity ?? readActiveGatewayLockIdentity;
  let gatewayLock: Awaited<ReturnType<typeof readGatewayLock>>;
  try {
    gatewayLock = await readGatewayLock({ env });
  } catch (error) {
    params.log.warn(
      `session: skipped interrupted-subagent reconciliation because gateway ownership could not be verified: ${String(error)}`,
    );
    return;
  }
  if (gatewayLock?.pid !== process.pid) {
    params.log.warn(
      "session: skipped interrupted-subagent reconciliation because this process does not own the verified gateway lock",
    );
    return;
  }

  const processStartedAtMs = params.deps?.processStartedAtMs ?? performance.timeOrigin;
  if (!Number.isFinite(processStartedAtMs)) {
    params.log.warn(
      "session: skipped interrupted-subagent reconciliation because the process start boundary is unavailable",
    );
    return;
  }

  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  let targets: ReturnType<typeof resolveTargets>;
  try {
    targets = resolveTargets(params.cfg, { env });
  } catch {
    // The shared startup discovery pass already logged this failure.
    return;
  }

  const hasCurrentRun =
    params.deps?.hasProjectedAgentRunForSession ?? hasProjectedAgentRunForSession;
  let reconciled = 0;
  for (const target of targets) {
    let entries: ReturnType<typeof listSessionEntriesReadOnly>;
    try {
      entries = listSessionEntriesReadOnly({
        agentId: target.agentId,
        clone: false,
        env,
        storePath: target.storePath,
      });
    } catch (error) {
      params.log.warn(
        `session: interrupted-subagent reconciliation could not read ${target.agentId}; continuing: ${String(error)}`,
      );
      continue;
    }
    for (const { entry, sessionKey } of entries) {
      if (
        entry.status !== "running" ||
        !isSubagentSessionKey(sessionKey) ||
        !isFiniteTimestamp(entry.startedAt) ||
        entry.startedAt >= processStartedAtMs ||
        entry.restartRecoveryRuns?.length
      ) {
        continue;
      }
      const runIdentity = {
        agentId: target.agentId,
        sessionId: entry.sessionId,
        sessionKeys: [sessionKey],
      };
      try {
        if (hasCurrentRun(runIdentity)) {
          continue;
        }
      } catch (error) {
        params.log.warn(
          `session: interrupted-subagent reconciliation could not verify run ownership for ${sessionKey}; continuing: ${String(error)}`,
        );
        continue;
      }
      try {
        const updated = await patchSessionEntryCore(
          {
            agentId: target.agentId,
            env,
            sessionKey,
            storePath: target.storePath,
          },
          (current) =>
            current.status === "running" &&
            isFiniteTimestamp(current.startedAt) &&
            current.startedAt < processStartedAtMs &&
            !current.restartRecoveryRuns?.length
              ? {
                  abortedLastRun: true,
                  lastRunError: INTERRUPTED_SUBAGENT_REASON,
                  status: "interrupted",
                }
              : null,
          {
            assertCommitAllowed: () => {
              if (hasCurrentRun(runIdentity)) {
                throw new Error("a current-process run owns this session");
              }
            },
            preserveActivity: true,
            skipMaintenance: true,
          },
        );
        if (updated?.status === "interrupted") {
          reconciled += 1;
        }
      } catch (error) {
        params.log.warn(
          `session: interrupted-subagent reconciliation skipped ${sessionKey}; continuing: ${String(error)}`,
        );
      }
    }
  }
  if (reconciled > 0) {
    params.log.info(`session: marked ${reconciled} prior-process subagent run(s) interrupted`);
  }
}

async function reconcileStartupSessionTranscriptIndexes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  const databaseExists =
    params.deps?.sessionSqliteDatabaseExists ??
    ((input: Parameters<SessionSqliteDatabaseExists>[0]) =>
      fs.existsSync(resolveOpenClawAgentSqlitePath(input)));
  const agentIds = listAgentIds(params.cfg).filter((agentId) =>
    databaseExists({
      agentId,
      ...(params.env ? { env: params.env } : {}),
    }),
  );
  if (agentIds.length === 0) {
    // No durable session rows can need projection repair when the agent DB is absent.
    // Avoid creating and schema-registering one empty DB per configured agent at startup.
    return;
  }
  const reconcile =
    params.deps?.reconcileSessionTranscriptIndexes ??
    (await import("../config/sessions/session-transcript-reconcile.js"))
      .reconcileSessionTranscriptIndexes;
  let reconciledSessions = 0;
  for (const agentId of agentIds) {
    const result = await reconcile({
      agentId,
      ...(params.env ? { env: params.env } : {}),
    });
    reconciledSessions += result.reconciledSessions;
  }
  if (reconciledSessions > 0) {
    params.log.info(
      `session: rebuilt ${reconciledSessions} transcript projection(s) before serving history`,
    );
  }
}

async function runStartupSessionSqliteImport(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  const env = params.env ?? process.env;
  const runDoctorSessionSqlite =
    params.deps?.runDoctorSessionSqlite ??
    (await import("../commands/doctor-session-sqlite.js")).runDoctorSessionSqlite;
  let report: DoctorSessionSqliteReport;
  try {
    report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: params.cfg,
      env,
      mode: "import",
    });
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      throw new Error(
        [
          `session SQLite migration failed during startup because an agent SQLite database could not be opened: ${String(error)}`,
          'Run "openclaw doctor --session-sqlite recover --session-sqlite-all-agents" to move the corrupt database aside and preserve it for support.',
        ].join("\n"),
        { cause: error },
      );
    }
    throw error;
  }
  const warningIssues = collectStartupWarningIssues(report);
  const blockingIssues = collectStartupBlockingIssues(report);
  if (blockingIssues.length > 0) {
    const recovery = await restoreFailedStartupSessionSqliteRun(params, report, blockingIssues);
    throw new Error(
      [
        `session SQLite migration failed during startup with ${blockingIssues.length} blocking issue(s).`,
        ...formatStartupIssueLines(blockingIssues).map((line) => `- ${line}`),
        'Run "openclaw doctor --session-sqlite inspect --session-sqlite-all-agents" for details.',
        ...(recovery.length > 0 ? recovery : []),
      ].join("\n"),
    );
  }
  if (sessionSqliteReportHasChanges(report)) {
    params.log.info(formatSessionSqliteStartupImportSummary(report));
  }
  if (warningIssues.length > 0) {
    params.log.warn(
      [
        `session: session SQLite migration warnings:\n${formatStartupIssueLines(warningIssues)
          .map((line) => `- ${line}`)
          .join("\n")}`,
      ].join("\n"),
    );
  }
}

async function restoreFailedStartupSessionSqliteRun(
  params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    log: SessionStartupMigrationLogger;
    deps?: SessionMigrationDeps;
  },
  report: DoctorSessionSqliteReport,
  blockingIssues: readonly DoctorSessionSqliteIssue[],
): Promise<string[]> {
  const manifestPath = report.migrationRun?.manifestPath;
  if (!manifestPath) {
    return report.migrationRun?.failureReportMarkdownPath
      ? [`Failure report: ${report.migrationRun.failureReportMarkdownPath}`]
      : [];
  }
  let restoreSessionSqliteMigrationRun = params.deps?.restoreSessionSqliteMigrationRun;
  let writeSessionSqliteMigrationFailureReports =
    params.deps?.writeSessionSqliteMigrationFailureReports;
  if (!restoreSessionSqliteMigrationRun || !writeSessionSqliteMigrationFailureReports) {
    const doctorModule = await import("../commands/doctor-session-sqlite.js");
    restoreSessionSqliteMigrationRun ??= doctorModule.restoreSessionSqliteMigrationRun;
    writeSessionSqliteMigrationFailureReports ??=
      doctorModule.writeSessionSqliteMigrationFailureReports;
  }
  const restore = restoreSessionSqliteMigrationRun({
    manifestPath,
    trustedTargets: report.targets.map(({ agentId, sqlitePath, storePath }) => ({
      agentId,
      sqlitePath,
      storePath,
    })),
  });
  const failureReports = writeSessionSqliteMigrationFailureReports(manifestPath, {
    reason: `startup blocked on ${blockingIssues.length} session SQLite issue(s)`,
  });
  params.log.warn(
    [
      "session: restored archived legacy transcript artifacts after startup SQLite migration failure:",
      `- restored=${restore.restoredFiles.length} skipped=${restore.skippedFiles.length} conflicts=${restore.conflicts.length}`,
      `- failureReport=${failureReports.markdownPath}`,
    ].join("\n"),
  );
  return [
    `Restore attempted for current migration run: restored=${restore.restoredFiles.length}, skipped=${restore.skippedFiles.length}, conflicts=${restore.conflicts.length}.`,
    `Failure report: ${failureReports.markdownPath}`,
  ];
}

function collectStartupBlockingIssues(
  report: DoctorSessionSqliteReport,
): DoctorSessionSqliteIssue[] {
  return report.targets.flatMap((target) =>
    target.issues.filter((issue) => !isSessionSqliteMigrationWarning(issue)),
  );
}

function collectStartupWarningIssues(
  report: DoctorSessionSqliteReport,
): DoctorSessionSqliteIssue[] {
  return report.targets.flatMap((target) => target.issues.filter(isSessionSqliteMigrationWarning));
}

function formatStartupIssueLines(issues: readonly DoctorSessionSqliteIssue[]): readonly string[] {
  return issues.slice(0, 10).map((issue) => {
    const key = issue.sessionKey ? `${issue.sessionKey}: ` : "";
    return `[${issue.code}] ${key}${issue.message}`;
  });
}

function sessionSqliteReportHasChanges(report: DoctorSessionSqliteReport): boolean {
  return (
    report.totals.importedEntries > 0 ||
    report.totals.importedTranscriptEvents > 0 ||
    report.totals.archivedTranscriptFiles > 0 ||
    report.totals.archivedUnreferencedJsonlFiles > 0
  );
}

function formatSessionSqliteStartupImportSummary(report: DoctorSessionSqliteReport): string {
  return [
    "session: imported legacy session metadata/transcripts into SQLite:",
    `- targets=${report.totals.targets} legacyEntries=${report.totals.legacyEntries} sqliteEntries=${report.totals.sqliteEntries}`,
    `- importedEntries=${report.totals.importedEntries} importedTranscriptEvents=${report.totals.importedTranscriptEvents}`,
    `- archivedTranscriptArtifacts=${report.totals.archivedTranscriptFiles} archivedUnreferencedJsonl=${report.totals.archivedUnreferencedJsonlFiles}`,
  ].join("\n");
}

function isSqliteCorruptionError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") {
    return true;
  }
  const message = String(error).toLowerCase();
  return message.includes("database disk image is malformed") || message.includes("not a database");
}
