// Legacy cron JSONL run-log migration into the authoritative task ledger.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { CronRunLogEntry } from "../../../cron/run-log-types.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { parseCronRunLogEntryObject } from "../../../cron/task-run-detail.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../../../infra/state-migrations.cron-run-logs.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";

const LEGACY_CRON_RUN_LOG_ARCHIVE_SUFFIX = ".migrated";

function parseCronRunLogEntriesFromJsonl(
  raw: string,
  opts?: { jobId?: string },
): CronRunLogEntry[] {
  const entries: CronRunLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const entry = parseCronRunLogEntryObject(JSON.parse(trimmed), opts);
      if (entry) {
        entries.push(entry);
      }
    } catch {
      // A malformed legacy line must not block import of the remaining history.
    }
  }
  return entries;
}

function archiveLegacyCronRunLogSync(filePath: string): void {
  const archivePath = `${filePath}${LEGACY_CRON_RUN_LOG_ARCHIVE_SUFFIX}`;
  if (!fsSync.existsSync(filePath) || fsSync.existsSync(archivePath)) {
    return;
  }
  try {
    fsSync.renameSync(filePath, archivePath);
  } catch {
    // Best-effort cleanup after durable task-ledger import.
  }
}

/** Import legacy per-job JSONL run logs into task_runs and archive migrated files. */
export async function migrateLegacyCronRunLogsToSqlite(
  storePath: string,
): Promise<{ importedFiles: number }> {
  const resolvedStorePath = path.resolve(storePath);
  const runsDir = path.resolve(path.dirname(resolvedStorePath), "runs");
  const files = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const jsonlFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  if (jsonlFiles.length === 0) {
    return { importedFiles: 0 };
  }

  for (const file of jsonlFiles) {
    const filePath = path.join(runsDir, file.name);
    const jobId = path.basename(file.name, ".jsonl");
    const entries = parseCronRunLogEntriesFromJsonl(fsSync.readFileSync(filePath, "utf-8"), {
      jobId,
    });

    runOpenClawStateWriteTransaction(({ db }) => {
      db.exec(`
        CREATE TABLE cron_run_logs (
          store_key TEXT NOT NULL,
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          entry_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (store_key, job_id, seq)
        );
      `);
      const insert = db.prepare(
        `INSERT INTO cron_run_logs
          (store_key, job_id, seq, ts, entry_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const storeKey = cronStoreKey(resolvedStorePath);
      for (const [index, entry] of entries.entries()) {
        insert.run(storeKey, jobId, index + 1, entry.ts, JSON.stringify(entry), Date.now());
      }
      migrateLegacyCronRunLogsToTaskRuns(db);
    });
    archiveLegacyCronRunLogSync(filePath);
  }
  return { importedFiles: jsonlFiles.length };
}

/** Return true when legacy cron JSONL run log files exist next to a store path. */
export async function legacyCronRunLogFilesExist(storePath: string): Promise<boolean> {
  const resolvedStorePath = path.resolve(storePath);
  const runsDir = path.resolve(path.dirname(resolvedStorePath), "runs");
  const files = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  return files.some((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
}
