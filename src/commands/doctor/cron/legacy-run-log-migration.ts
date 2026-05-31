import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCronRunLogEntriesFromJsonl } from "../../../cron/run-log-jsonl.js";
import {
  appendCronRunLog,
  readCronRunLogEntriesPage,
  type CronRunLogEntry,
} from "../../../cron/run-log.js";

const LEGACY_CRON_RUN_LOG_ARCHIVE_SUFFIX = ".migrated";

function legacyRunLogKey(entry: CronRunLogEntry): string {
  return [
    entry.jobId,
    entry.ts,
    entry.runId ?? "",
    entry.status ?? "",
    entry.summary ?? "",
    entry.error ?? "",
  ].join("\0");
}

async function readExistingRunLogKeys(params: {
  storePath: string;
  jobId: string;
}): Promise<Set<string>> {
  const keys = new Set<string>();
  let offset = 0;
  while (true) {
    const page = await readCronRunLogEntriesPage({
      storePath: params.storePath,
      jobId: params.jobId,
      limit: 200,
      offset,
      sortDir: "asc",
    });
    for (const entry of page.entries) {
      keys.add(legacyRunLogKey(entry));
    }
    if (!page.hasMore) {
      return keys;
    }
    offset = page.nextOffset ?? offset + page.entries.length;
  }
}

async function importLegacyCronRunLog(
  filePath: string,
  params: { storePath: string; jobId: string },
) {
  const resolved = path.resolve(filePath);
  if (!fsSync.existsSync(resolved)) {
    return;
  }

  const existingKeys = await readExistingRunLogKeys(params);
  const raw = fsSync.readFileSync(resolved, "utf-8");
  for (const entry of parseCronRunLogEntriesFromJsonl(raw, { jobId: params.jobId })) {
    const key = legacyRunLogKey(entry);
    if (existingKeys.has(key)) {
      continue;
    }
    existingKeys.add(key);
    await appendCronRunLog({
      storePath: params.storePath,
      entry,
      opts: { keepLines: false },
    });
  }

  archiveLegacyCronRunLogSync(resolved);
}

function archiveLegacyCronRunLogSync(filePath: string): void {
  const archivePath = `${filePath}${LEGACY_CRON_RUN_LOG_ARCHIVE_SUFFIX}`;
  if (!fsSync.existsSync(filePath) || fsSync.existsSync(archivePath)) {
    return;
  }
  try {
    fsSync.renameSync(filePath, archivePath);
  } catch {
    // Best-effort cleanup after durable SQLite import.
  }
}

export async function migrateLegacyCronRunLogsToSqlite(
  storePath: string,
): Promise<{ importedFiles: number }> {
  const resolvedStorePath = path.resolve(storePath);
  const runsDir = path.resolve(path.dirname(resolvedStorePath), "runs");
  const files = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const jsonlFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));

  for (const file of jsonlFiles) {
    const jobId = path.basename(file.name, ".jsonl");
    await importLegacyCronRunLog(path.join(runsDir, file.name), {
      storePath: resolvedStorePath,
      jobId,
    });
  }

  return { importedFiles: jsonlFiles.length };
}

export async function legacyCronRunLogFilesExist(storePath: string): Promise<boolean> {
  const resolvedStorePath = path.resolve(storePath);
  const runsDir = path.resolve(path.dirname(resolvedStorePath), "runs");
  const files = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  return files.some((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
}
