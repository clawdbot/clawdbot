import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  readLatestBackupRun,
  readLatestSuccessfulBackupRun,
  type BackupRunRecord,
} from "../state/backup-run-records.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";

// Backups older than two weeks no longer provide a useful routine recovery point.
const BACKUP_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1_000;

type BackupFreshness = {
  latest?: BackupRunRecord;
  latestOk?: BackupRunRecord;
};

/** Read backup freshness without creating or repairing an absent state database. */
export function readBackupFreshness(env: NodeJS.ProcessEnv): BackupFreshness {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => ({
        latest: readLatestBackupRun(db),
        latestOk: readLatestSuccessfulBackupRun(db),
      }),
      { env },
    ) ?? {}
  );
}

/** Format the compact status overview value for the latest backup attempt. */
export function buildBackupStatusValue(params: {
  freshness: BackupFreshness;
  now?: number;
  formatTimeAgo: (ageMs: number) => string;
}): string {
  const latest = params.freshness.latest;
  if (!latest) {
    return "none recorded";
  }
  const age = params.formatTimeAgo(Math.max(0, (params.now ?? Date.now()) - latest.createdAt));
  return latest.status === "ok"
    ? `last ok ${age} (${latest.kind}${latest.pushFailed ? ", push failing" : ""})`
    : `last attempt failed ${age} (${latest.kind})`;
}

/** Build the informational Doctor hint for missing or stale successful backups. */
function buildBackupDoctorHint(params: {
  freshness: BackupFreshness;
  now?: number;
}): string | null {
  const latestOk = params.freshness.latestOk;
  if (latestOk?.pushFailed) {
    return [
      "The newest local Git backup succeeded, but its requested push failed.",
      `Check the configured Git remote for ${latestOk.archivePath}, then retry the backup.`,
    ].join("\n");
  }
  const stale =
    !latestOk || (params.now ?? Date.now()) - latestOk.createdAt > BACKUP_STALE_AFTER_MS;
  if (!stale) {
    return null;
  }
  return [
    latestOk
      ? "The newest successful backup is more than 14 days old."
      : "No successful backup is recorded.",
    `Create one now with ${formatCliCommand("openclaw backup create")}.`,
    `Schedule versioned backups with ${formatCliCommand("openclaw backup enable --repository <dir>")}.`,
  ].join("\n");
}

/** Emit the non-repairing backup freshness hint when it applies. */
export function noteBackupDoctorHint(env: NodeJS.ProcessEnv): void {
  const hint = buildBackupDoctorHint({ freshness: readBackupFreshness(env) });
  if (hint) {
    note(hint, "Backups");
  }
}
