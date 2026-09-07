/** Top-level doctor command wrapper, including post-upgrade probe mode. */
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import type { DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";

async function resolveExplicitSessionSqliteMaintenancePaths(
  options: DoctorOptions,
): Promise<string[]> {
  if (!options.sessionSqliteStore) {
    return [];
  }
  const [
    { resolveSessionStoreTargets },
    { resolveSqliteTargetFromSessionStorePath },
    { resolveSqliteDatabaseFilePaths },
  ] = await Promise.all([
    import("../config/sessions/targets.js"),
    import("../config/sessions/session-sqlite-target.js"),
    import("../infra/sqlite-files.js"),
  ]);
  const requestedAgentId = normalizeAgentId(options.sessionSqliteAgent ?? LEGACY_IMPLICIT_AGENT_ID);
  // Explicit path mode intentionally bypasses runtime config. Resolve through
  // the same selector as the migration so ownership checks cover exact targets.
  const targets = resolveSessionStoreTargets(
    { agents: { entries: { [requestedAgentId]: { default: true } } } },
    {
      store: options.sessionSqliteStore,
      ...(options.sessionSqliteAgent ? { agent: options.sessionSqliteAgent } : {}),
      ...(options.sessionSqliteAllAgents ? { allAgents: true } : {}),
    },
    { env: process.env },
  );
  const protectedPaths = new Set<string>();
  for (const target of targets) {
    protectedPaths.add(target.storePath);
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
    }).path;
    if (sqlitePath) {
      for (const databasePath of resolveSqliteDatabaseFilePaths(sqlitePath)) {
        protectedPaths.add(databasePath);
      }
    }
  }
  return [...protectedPaths];
}

/** Runs doctor or the post-upgrade probe submode using the provided runtime. */
export async function doctorCommand(runtime?: RuntimeEnv, options?: DoctorOptions): Promise<void> {
  const outputRuntime = runtime ?? defaultRuntime;
  if (options?.stateSqlite) {
    const { runDoctorStateSqliteCompact } = await import("./doctor-state-sqlite-compact.js");
    const report = await runDoctorStateSqliteCompact();
    if (options.json) {
      writeRuntimeJson(outputRuntime, report);
    } else if (report.skipped) {
      outputRuntime.log(`state-sqlite compact: skipped; database missing at ${report.path}`);
    } else {
      outputRuntime.log(
        `state-sqlite compact: reclaimed=${report.reclaimedBytes} bytes, db=${report.before.dbSizeBytes}->${report.after.dbSizeBytes} bytes, wal=${report.before.walSizeBytes}->${report.after.walSizeBytes} bytes`,
      );
      outputRuntime.log(
        `- freelist=${report.before.freelistPages}->${report.after.freelistPages} pages, page-size=${report.after.pageSizeBytes} bytes, auto-vacuum=${report.before.autoVacuum}->${report.after.autoVacuum}`,
      );
      outputRuntime.log(`- integrity-check=${report.integrityCheck}, path=${report.path}`);
    }
    exitCliAfterOutput(outputRuntime, 0);
  }
  if (options?.sessionSqlite) {
    const sessionSqliteMode = options.sessionSqlite;
    const { isDestructiveDoctorSessionSqliteMode, withDoctorSqliteMaintenanceLock } =
      await import("./doctor-sqlite-maintenance-lock.js");
    const { runDoctorSessionSqlite, reconcileDoctorSessionSqlitePublication } =
      await import("./doctor-session-sqlite.js");
    const sessionSqliteOptions = {
      mode: sessionSqliteMode,
      ...(options.sessionSqliteStore ? { store: options.sessionSqliteStore } : {}),
      ...(options.sessionSqliteAgent ? { agent: options.sessionSqliteAgent } : {}),
      ...(options.sessionSqliteAllAgents ? { allAgents: true } : {}),
    };
    const runSessionSqlite = async () => await runDoctorSessionSqlite(sessionSqliteOptions);
    const reconcileHardlink = (filePath: string) =>
      reconcileDoctorSessionSqlitePublication(sessionSqliteOptions, filePath);
    const report = isDestructiveDoctorSessionSqliteMode(sessionSqliteMode)
      ? await withDoctorSqliteMaintenanceLock({
          env: process.env,
          operation: `session SQLite ${sessionSqliteMode}`,
          ...(options.sessionSqliteStore
            ? { protectedPaths: await resolveExplicitSessionSqliteMaintenancePaths(options) }
            : {}),
          ...(sessionSqliteMode !== "compact" ? { reconcileHardlink } : {}),
          run: runSessionSqlite,
        })
      : await runSessionSqlite();
    if (sessionSqliteMode === "recover" && options.sessionSqliteGithubIssue === true) {
      await maybeCreateSessionSqliteGithubIssue(outputRuntime, report, options);
    }
    if (options.json) {
      writeRuntimeJson(outputRuntime, report);
    } else {
      outputRuntime.log(
        `session-sqlite ${report.mode}: ${report.totals.targets} target(s), ${report.totals.legacyEntries} legacy entries, ${report.totals.sqliteEntries} sqlite entries, ${report.totals.issues} issue(s)`,
      );
      if (report.migrationRun) {
        outputRuntime.log(`- migration-run=${report.migrationRun.runId}`);
        outputRuntime.log(`- manifest=${report.migrationRun.manifestPath}`);
        if (report.migrationRun.failureReportMarkdownPath) {
          outputRuntime.log(`- failure-report=${report.migrationRun.failureReportMarkdownPath}`);
        }
      }
      if (report.supportIssue) {
        outputRuntime.log(`- support-issue-report=${report.supportIssue.bodyPath ?? "inline"}`);
      }
      for (const target of report.targets) {
        outputRuntime.log(
          `- ${target.agentId}: imported=${target.importedEntries}/${target.importedTranscriptEvents} events, validated=${target.validatedEntries}/${target.validatedTranscriptEvents} events, archived-unreferenced-jsonl=${target.archivedUnreferencedJsonlFiles.length}, unreferenced-jsonl=${target.unreferencedJsonlFiles.length}`,
        );
        if (target.restore) {
          outputRuntime.log(
            `  restored=${target.restore.restoredFiles.length}, skipped=${target.restore.skippedFiles.length}, conflicts=${target.restore.conflicts.length}, manifests=${target.restore.manifestPaths.length}`,
          );
        }
        if (target.compact) {
          outputRuntime.log(
            `  compact reclaimed=${target.compact.reclaimedBytes} bytes, db=${target.compact.dbSizeBeforeBytes}->${target.compact.dbSizeAfterBytes} bytes, wal=${target.compact.walSizeBeforeBytes}->${target.compact.walSizeAfterBytes} bytes`,
          );
        }
        if (target.corruptRecovery) {
          outputRuntime.log(
            `  corrupt-db-recovery moved=${target.corruptRecovery.movedFiles.length}, skipped=${target.corruptRecovery.skippedFiles.length}`,
          );
        }
        for (const issue of target.issues.slice(0, 10)) {
          outputRuntime.log(
            `  [${issue.code}]${issue.sessionKey ? ` ${issue.sessionKey}:` : ""} ${issue.message}`,
          );
        }
        if (target.issues.length > 10) {
          outputRuntime.log(`  ...and ${target.issues.length - 10} more issue(s)`);
        }
      }
    }
    exitCliAfterOutput(outputRuntime, report.totals.issues > 0 ? 1 : 0);
  }
  if (options?.postUpgrade) {
    const { runPostUpgradeProbes } = await import("./doctor-post-upgrade.js");
    const report = await runPostUpgradeProbes({});
    if (options.json) {
      writeRuntimeJson(outputRuntime, report);
    } else {
      for (const f of report.findings) {
        outputRuntime.log(`[${f.level}] ${f.code}: ${f.message}`);
      }
      if (report.findings.length === 0) {
        outputRuntime.log("post-upgrade: no findings");
      }
    }
    const hasError = report.findings.some((f) => f.level === "error");
    exitCliAfterOutput(outputRuntime, hasError ? 1 : 0);
  }
  const doctorHealth = await import("../flows/doctor-health.js");
  await doctorHealth.runDoctorHealthFlow(runtime, options);
}

async function maybeCreateSessionSqliteGithubIssue(
  runtime: RuntimeEnv,
  report: DoctorSessionSqliteReport,
  options: DoctorOptions,
): Promise<void> {
  const shouldLog = options.json !== true;
  const supportIssue = report.supportIssue;
  if (!supportIssue) {
    if (shouldLog) {
      runtime.log("session-sqlite recover: no support issue payload was generated");
    }
    return;
  }
  let approved = options.yes === true;
  if (!approved && options.nonInteractive !== true && options.json !== true) {
    const { promptYesNo } = await import("../cli/prompt.js");
    approved = await promptYesNo(
      "Create a GitHub issue in openclaw/openclaw with the sanitized recovery report?",
      false,
    );
  }
  if (!approved) {
    supportIssue.github = { status: "skipped" };
    if (shouldLog) {
      runtime.log("session-sqlite recover: GitHub issue creation skipped");
    }
    return;
  }
  const manifestPath = report.migrationRun?.manifestPath;
  if (!manifestPath) {
    setSessionSqliteGithubIssueFailure(
      runtime,
      supportIssue,
      shouldLog,
      "GitHub issue creation is unavailable because its private retry receipt could not be prepared.",
    );
    return;
  }
  const { prepareGithubIssue, reconcileGithubIssue, submitGithubIssue } =
    await import("../infra/github-issue.js");
  const { claimSessionSqliteMigrationGithubIssue, clearSessionSqliteMigrationGithubIssueClaim } =
    await import("./doctor-session-sqlite-failure.js");
  const prepared = prepareGithubIssue({ body: supportIssue.body, title: supportIssue.title });
  let claim: ReturnType<typeof claimSessionSqliteMigrationGithubIssue>;
  try {
    claim = await withSessionSqliteGithubIssueReceipt(manifestPath, (authority) =>
      claimSessionSqliteMigrationGithubIssue(
        manifestPath,
        { marker: prepared.marker, title: prepared.title },
        authority,
      ),
    );
  } catch {
    claim = undefined;
  }
  if (!claim) {
    setSessionSqliteGithubIssueFailure(
      runtime,
      supportIssue,
      shouldLog,
      "GitHub issue creation is unavailable because its private retry receipt could not be saved.",
    );
    return;
  }
  supportIssue.title = claim.issue.title;
  const claimedIssue = prepareGithubIssue({ body: supportIssue.body, title: claim.issue.title });
  if (claimedIssue.marker !== claim.issue.marker) {
    setSessionSqliteGithubIssueFailure(
      runtime,
      supportIssue,
      shouldLog,
      "GitHub issue creation is unavailable because its private retry receipt is inconsistent.",
    );
    return;
  }
  if (claim.status === "existing") {
    const reconciled = await reconcileGithubIssue(claimedIssue).catch(() => ({
      status: "unavailable" as const,
    }));
    if (reconciled.status === "created") {
      setSessionSqliteGithubIssueCreated(runtime, supportIssue, shouldLog, reconciled.url);
      return;
    }
    setSessionSqliteGithubIssueFailure(
      runtime,
      supportIssue,
      shouldLog,
      "A prior GitHub issue handoff may already have created this report; no duplicate was opened.",
    );
    return;
  }
  const created = await submitGithubIssue(claimedIssue).catch(() => ({
    reason: "creation-outcome-unknown" as const,
    status: "outcome-unknown" as const,
  }));
  if (created.status === "created") {
    setSessionSqliteGithubIssueCreated(runtime, supportIssue, shouldLog, created.url);
    return;
  }
  if (created.status === "outcome-unknown") {
    setSessionSqliteGithubIssueFailure(
      runtime,
      supportIssue,
      shouldLog,
      "GitHub issue creation outcome is unknown; no duplicate was opened.",
    );
    return;
  }
  if (created.status === "fallback-unavailable") {
    await withSessionSqliteGithubIssueReceipt(manifestPath, (authority) =>
      clearSessionSqliteMigrationGithubIssueClaim(manifestPath, claimedIssue.marker, authority),
    ).catch(() => false);
    setSessionSqliteGithubIssueFailure(
      runtime,
      supportIssue,
      shouldLog,
      "GitHub issue creation is unavailable, and this report is too large for a safe browser fallback.",
    );
    return;
  }
  const message =
    created.reason === "cli-unavailable"
      ? "GitHub CLI is unavailable."
      : created.reason === "authentication-unavailable"
        ? "GitHub authentication is unavailable."
        : "GitHub issue creation is unavailable.";
  const { detectBrowserOpenSupport, openUrl } = await import("../infra/browser-open.js");
  const browserSupport = await detectBrowserOpenSupport().catch(() => ({ ok: false }));
  const opened = browserSupport.ok ? await openUrl(created.url).catch(() => false) : false;
  if (!browserSupport.ok) {
    await withSessionSqliteGithubIssueReceipt(manifestPath, (authority) =>
      clearSessionSqliteMigrationGithubIssueClaim(manifestPath, claimedIssue.marker, authority),
    ).catch(() => false);
  }
  supportIssue.github = { message, status: "failed" };
  if (shouldLog) {
    runtime.log(`session-sqlite recover: ${message}`);
    runtime.log(
      opened
        ? "session-sqlite recover: opened the sanitized fallback in your browser"
        : "session-sqlite recover: browser handoff unavailable; the sanitized report remains available in the recovery result",
    );
  }
}

async function withSessionSqliteGithubIssueReceipt<T>(
  manifestPath: string,
  run: (authority: DoctorSqliteMaintenanceAuthority) => Promise<T> | T,
): Promise<T> {
  const { withDoctorSqliteMaintenanceLock } = await import("./doctor-sqlite-maintenance-lock.js");
  return await withDoctorSqliteMaintenanceLock({
    env: process.env,
    operation: "session SQLite GitHub issue receipt",
    protectedPaths: [manifestPath],
    run,
  });
}

function setSessionSqliteGithubIssueCreated(
  runtime: RuntimeEnv,
  issue: NonNullable<DoctorSessionSqliteReport["supportIssue"]>,
  shouldLog: boolean,
  url: string,
): void {
  issue.github = { status: "created", url };
  if (shouldLog) {
    runtime.log(`session-sqlite recover: created GitHub issue ${url}`);
  }
}

function setSessionSqliteGithubIssueFailure(
  runtime: RuntimeEnv,
  issue: NonNullable<DoctorSessionSqliteReport["supportIssue"]>,
  shouldLog: boolean,
  message: string,
): void {
  issue.github = { message, status: "failed" };
  if (shouldLog) {
    runtime.log(`session-sqlite recover: ${message}`);
  }
}
