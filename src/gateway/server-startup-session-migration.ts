import { listAgentIds } from "../agents/agent-scope.js";
import type {
  DoctorSessionSqliteIssue,
  DoctorSessionSqliteReport,
  DoctorSessionSqliteRestoreReport,
} from "../commands/doctor-session-sqlite.js";
import {
  runSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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

type SessionMigrationDeps = Parameters<typeof runSessionStartupMigration>[0]["deps"] & {
  reconcileSessionTranscriptIndexes?: typeof import("../config/sessions/session-transcript-reconcile.js").reconcileSessionTranscriptIndexes;
  restoreSessionSqliteMigrationRun?: SessionSqliteStartupRestoreRunner;
  runDoctorSessionSqlite?: SessionSqliteStartupImportRunner;
  writeSessionSqliteMigrationFailureReports?: SessionSqliteStartupFailureReportWriter;
};

const STARTUP_WARNING_ISSUE_CODES = new Set([
  "entry_invalid",
  "transcript_archive_failed",
  "transcript_malformed",
  "transcript_missing",
  "unreferenced_jsonl_archive_failed",
]);

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
  await runSessionStartupMigration(params);
  await runStartupSessionSqliteImport(params);
  await reconcileStartupSessionTranscriptIndexes(params);
}

async function reconcileStartupSessionTranscriptIndexes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  const reconcile =
    params.deps?.reconcileSessionTranscriptIndexes ??
    (await import("../config/sessions/session-transcript-reconcile.js"))
      .reconcileSessionTranscriptIndexes;
  let reconciledSessions = 0;
  for (const agentId of listAgentIds(params.cfg)) {
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
    target.issues.filter((issue) => !STARTUP_WARNING_ISSUE_CODES.has(issue.code)),
  );
}

function collectStartupWarningIssues(
  report: DoctorSessionSqliteReport,
): DoctorSessionSqliteIssue[] {
  return report.targets.flatMap((target) =>
    target.issues.filter((issue) => STARTUP_WARNING_ISSUE_CODES.has(issue.code)),
  );
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
