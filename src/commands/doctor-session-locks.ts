/** Doctor diagnostics and cleanup for stale session write lock files. */
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import {
  cleanStaleLockFiles,
  resolveSessionWriteLockStaleMs,
  type SessionLockInspection,
  type SessionLockOwnerProcessArgsReader,
  type SessionWriteLockAcquireTimeoutConfig,
} from "../agents/session-write-lock.js";
import { resolveStateDir } from "../config/paths.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { shortenHomePath } from "../utils.js";

const SESSION_LOCKS_CHECK_ID = "core/doctor/session-locks";
const REPORT_ONLY_STALE_LOCK_REASONS = new Set(["too-old", "hold-exceeded"]);

function isReportOnlyStaleLock(lock: SessionLockInspection): boolean {
  return (
    lock.staleReasons.length > 0 &&
    lock.staleReasons.every((reason) => REPORT_ONLY_STALE_LOCK_REASONS.has(reason))
  );
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) {
    return "unknown";
  }
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}

function formatLockLine(lock: SessionLockInspection): string {
  const pidStatus =
    lock.pid === null ? "pid=missing" : `pid=${lock.pid} (${lock.pidAlive ? "alive" : "dead"})`;
  const ageStatus = `age=${formatAge(lock.ageMs)}`;
  const staleStatus = lock.stale
    ? `stale=yes (${lock.staleReasons.join(", ") || "unknown"})`
    : "stale=no";
  const removedStatus = lock.removed ? " [removed]" : "";
  return `- ${shortenHomePath(lock.lockPath)} ${pidStatus} ${ageStatus} ${staleStatus}${removedStatus}`;
}

export async function detectStaleSessionLocks(params?: {
  config?: SessionWriteLockAcquireTimeoutConfig;
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}): Promise<readonly SessionLockInspection[]> {
  const staleMs = params?.staleMs ?? resolveSessionWriteLockStaleMs(params?.config, params?.env);
  const env = params?.env ?? process.env;
  const sessionDirs = await resolveAgentSessionDirs(resolveStateDir(env));
  const staleLocks: SessionLockInspection[] = [];
  for (const sessionsDir of sessionDirs) {
    const result = await cleanStaleLockFiles({
      sessionsDir,
      staleMs,
      removeStale: false,
      readOwnerProcessArgs: params?.readOwnerProcessArgs,
    });
    staleLocks.push(...result.locks.filter((lock) => lock.stale));
  }
  return staleLocks.toSorted((a, b) => a.lockPath.localeCompare(b.lockPath));
}

export function sessionLockToHealthFinding(lock: SessionLockInspection): HealthFinding {
  const fixHint = lock.removable
    ? 'Run "openclaw doctor --fix" to remove this stale lock file automatically.'
    : isReportOnlyStaleLock(lock)
      ? "OpenClaw is preserving this live owned lock; inspect the owning process if it appears stuck."
      : 'Run "openclaw doctor --fix" after the cleanup grace period if this stale lock remains.';
  return {
    checkId: SESSION_LOCKS_CHECK_ID,
    severity: "warning",
    message: `Stale session lock file: ${shortenHomePath(lock.lockPath)} (${lock.staleReasons.join(", ") || "unknown"})`,
    path: lock.lockPath,
    fixHint,
  };
}

export function sessionLockToRepairEffect(lock: SessionLockInspection): HealthRepairEffect {
  const action = lock.removable
    ? "would-remove-stale-session-lock"
    : isReportOnlyStaleLock(lock)
      ? "would-preserve-report-only-stale-session-lock"
      : "would-preserve-mtime-gated-stale-session-lock";
  return {
    kind: "state",
    action,
    target: lock.lockPath,
    dryRunSafe: false,
  };
}

/** Reports session write locks and removes stale locks when doctor repair is enabled. */
export async function noteSessionLockHealth(params?: {
  shouldRepair?: boolean;
  config?: SessionWriteLockAcquireTimeoutConfig;
  env?: NodeJS.ProcessEnv;
  staleMs?: number;
  readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
}) {
  const shouldRepair = params?.shouldRepair === true;
  const staleMs = params?.staleMs ?? resolveSessionWriteLockStaleMs(params?.config, params?.env);
  let sessionDirs: string[];
  try {
    sessionDirs = await resolveAgentSessionDirs(resolveStateDir(process.env));
  } catch (err) {
    note(`- Failed to inspect session lock files: ${String(err)}`, "Session locks");
    return;
  }

  if (sessionDirs.length === 0) {
    return;
  }

  const allLocks: SessionLockInspection[] = [];
  for (const sessionsDir of sessionDirs) {
    const result = await cleanStaleLockFiles({
      sessionsDir,
      staleMs,
      removeStale: shouldRepair,
      readOwnerProcessArgs: params?.readOwnerProcessArgs,
    });
    allLocks.push(...result.locks);
  }

  if (allLocks.length === 0) {
    return;
  }

  const staleCount = allLocks.filter((lock) => lock.stale).length;
  const removedCount = allLocks.filter((lock) => lock.removed).length;
  const lines: string[] = [
    `- Found ${allLocks.length} session lock file${allLocks.length === 1 ? "" : "s"}.`,
    ...allLocks.toSorted((a, b) => a.lockPath.localeCompare(b.lockPath)).map(formatLockLine),
  ];

  if (staleCount > 0 && !shouldRepair) {
    lines.push(`- ${staleCount} lock file${staleCount === 1 ? " is" : "s are"} stale.`);
    lines.push('- Run "openclaw doctor --fix" to remove stale lock files automatically.');
  }
  if (shouldRepair && removedCount > 0) {
    lines.push(
      `- Removed ${removedCount} stale session lock file${removedCount === 1 ? "" : "s"}.`,
    );
  }

  note(lines.join("\n"), "Session locks");
}
