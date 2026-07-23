/** Top-level doctor command wrapper, including post-upgrade probe mode. */
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStoreTargets } from "../config/sessions/targets.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { runPostUpgradeProbes } from "./doctor-post-upgrade.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import type { DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import {
  isDestructiveDoctorSessionSqliteMode,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";

function resolveExplicitSessionSqliteMaintenancePaths(options: DoctorOptions): string[] {
  if (!options.sessionSqliteStore) {
    return [];
  }
  // Explicit path mode intentionally bypasses runtime config. Resolve through
  // the same selector as the migration so ownership checks cover exact targets.
  const targets = resolveSessionStoreTargets(
    { agents: { entries: { [LEGACY_IMPLICIT_AGENT_ID]: { default: true } } } },
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
  if (options?.stateSqlite) {
    const outputRuntime = runtime ?? defaultRuntime;
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
    outputRuntime.exit(0);
    return;
  }
  if (options?.sessionSqlite) {
    const outputRuntime = runtime ?? defaultRuntime;
    const sessionSqliteMode = options.sessionSqlite;
    const { runDoctorSessionSqlite } = await import("./doctor-session-sqlite.js");
    const runSessionSqlite = async () =>
      await runDoctorSessionSqlite({
        mode: sessionSqliteMode,
        ...(options.sessionSqliteStore ? { store: options.sessionSqliteStore } : {}),
        ...(options.sessionSqliteAgent ? { agent: options.sessionSqliteAgent } : {}),
        ...(options.sessionSqliteAllAgents ? { allAgents: true } : {}),
      });
    const report = isDestructiveDoctorSessionSqliteMode(sessionSqliteMode)
      ? await withDoctorSqliteMaintenanceLock({
          env: process.env,
          operation: `session SQLite ${sessionSqliteMode}`,
          ...(options.sessionSqliteStore
            ? { protectedPaths: resolveExplicitSessionSqliteMaintenancePaths(options) }
            : {}),
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
        outputRuntime.log(`- support-issue-url=${report.supportIssue.url}`);
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
    outputRuntime.exit(report.totals.issues > 0 ? 1 : 0);
    return;
  }
  if (options?.postUpgrade) {
    const outputRuntime = runtime ?? defaultRuntime;
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
    outputRuntime.exit(hasError ? 1 : 0);
    return;
  }
  const doctorHealth = await import("../flows/doctor-health.js");
  await doctorHealth.doctorCommand(runtime, options);
}

async function maybeCreateSessionSqliteGithubIssue(
  runtime: RuntimeEnv,
  report: DoctorSessionSqliteReport,
  options: DoctorOptions,
): Promise<void> {
  const shouldLog = options.json !== true;
  if (!report.supportIssue) {
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
    report.supportIssue.github = { status: "skipped" };
    if (shouldLog) {
      runtime.log("session-sqlite recover: GitHub issue creation skipped");
    }
    return;
  }
  const { createSessionSqliteGithubIssue } =
    await import("./doctor-session-sqlite-github-issue.js");
  const created = createSessionSqliteGithubIssue(report.supportIssue);
  if (created.ok) {
    report.supportIssue.github = { status: "created", url: created.url };
    if (shouldLog) {
      runtime.log(`session-sqlite recover: created GitHub issue ${created.url}`);
    }
    return;
  }
  report.supportIssue.github = {
    fallbackUrl: created.fallbackUrl,
    message: created.message,
    status: "failed",
  };
  if (shouldLog) {
    runtime.log(`session-sqlite recover: GitHub issue creation unavailable: ${created.message}`);
    runtime.log(`session-sqlite recover: prefilled issue URL ${created.fallbackUrl}`);
  }
}
