import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
  type SessionPhysicalDiskUsage,
} from "./disk-budget.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

export async function reclaimSqliteFreePages(
  databaseOptions: OpenClawAgentDatabaseOptions,
): Promise<void> {
  let remaining: number | undefined;
  while (remaining === undefined || remaining > 0) {
    if (remaining !== undefined) {
      await setImmediate();
    }
    // Reacquire after yielding: idle cached handles can be evicted between passes.
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.walMaintenance.checkpoint();
    // sqlite-allow-raw -- Physical budget decisions need current SQLite page accounting.
    const freePages = () =>
      Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0);
    const before = freePages();
    if (!Number.isSafeInteger(before) || before <= 0) {
      return;
    }
    // Bound the entire drain to its initial freelist, even if other writers free more pages.
    remaining = Math.min(remaining ?? before, before);
    const pages = Math.min(512, remaining);
    database.db.exec(`PRAGMA incremental_vacuum(${pages});`); // sqlite-allow-raw -- Bounded maintenance outside a transaction.
    database.walMaintenance.checkpoint();
    remaining -= pages;
    if (freePages() >= before) {
      return;
    }
  }
}

export function hasCanonicalSessionTranscriptArchives(
  databaseOptions: OpenClawAgentDatabaseOptions,
): boolean {
  // openclaw-agent-db.ts cache rule: LRU eviction closes idle handles across awaits.
  const database = openOpenClawAgentDatabase(databaseOptions);
  const db = getSessionKysely(database.db);
  const table = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("sqlite_schema")
      .select("name")
      .where("type", "=", "table")
      .where("name", "=", "session_transcript_archives"),
  ).rows[0];
  if (!table) {
    return false;
  }
  return (
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select("session_id")
        .where("published_at", "is not", null)
        .limit(1),
    ).rows.length > 0
  );
}

function readUnpublishedSessionTranscriptArchiveNames(
  databaseOptions: OpenClawAgentDatabaseOptions,
): Set<string> {
  // openclaw-agent-db.ts cache rule: LRU eviction closes idle handles across awaits.
  const database = openOpenClawAgentDatabase(databaseOptions);
  const db = getSessionKysely(database.db);
  const table = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("sqlite_schema")
      .select("name")
      .where("type", "=", "table")
      .where("name", "=", "session_transcript_archives"),
  ).rows[0];
  if (!table) {
    return new Set();
  }
  return new Set(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select("archive_name")
        .where("published_at", "is", null),
    ).rows.map((row) => row.archive_name),
  );
}

async function pruneCanonicalSessionTranscriptArchivesToHighWater(params: {
  archiveDirectory: string;
  databaseOptions: OpenClawAgentDatabaseOptions;
  highWaterBytes: number;
  storePath: string;
}): Promise<{ removedFiles: number; usage: SessionPhysicalDiskUsage }> {
  let usage = await measureSessionPhysicalDiskUsage(params.storePath);
  let removedFiles = 0;
  while (usage.totalBytes > params.highWaterBytes) {
    // openclaw-agent-db.ts cache rule: LRU eviction closes idle handles across awaits.
    const database = openOpenClawAgentDatabase(params.databaseOptions);
    const db = getSessionKysely(database.db);
    const row = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select(["archive_name", "generation", "session_id"])
        .where("published_at", "is not", null)
        .orderBy("created_at", "asc")
        .orderBy("session_id", "asc")
        .orderBy("generation", "asc")
        .limit(1),
    ).rows[0];
    if (!row) {
      break;
    }
    const archivePath = path.resolve(params.archiveDirectory, row.archive_name);
    if (
      path.dirname(archivePath) !== path.resolve(params.archiveDirectory) ||
      path.basename(archivePath) !== row.archive_name
    ) {
      throw new Error(`Invalid canonical session archive name for ${row.session_id}`);
    }
    try {
      await fs.promises.rm(archivePath);
      removedFiles += 1;
    } catch (error) {
      // SAFETY: Node filesystem failures expose the documented errno code field.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // The database is the recovery copy. Retain it unless its derived file
        // is gone, otherwise retention could leave an undeletable orphan.
        break;
      }
    }
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const transactionKysely = getSessionKysely(transactionDb.db);
      executeSqliteQuerySync(
        transactionDb.db,
        transactionKysely
          .deleteFrom("session_transcript_archives")
          .where("session_id", "=", row.session_id)
          .where("generation", "=", row.generation),
      );
    }, params.databaseOptions);
    await reclaimSqliteFreePages(params.databaseOptions);
    usage = await measureSessionPhysicalDiskUsage(params.storePath);
  }
  return { removedFiles, usage };
}

export async function pruneAllSessionTranscriptArchivesToHighWater(params: {
  archiveDirectory: string;
  databaseOptions: OpenClawAgentDatabaseOptions;
  highWaterBytes: number;
  storePath: string;
}): Promise<{ removedFiles: number; usage: SessionPhysicalDiskUsage }> {
  // Reclaim committed free pages before pressure can destroy a retained archive.
  await reclaimSqliteFreePages(params.databaseOptions);
  const canonical = hasCanonicalSessionTranscriptArchives(params.databaseOptions)
    ? await pruneCanonicalSessionTranscriptArchivesToHighWater(params)
    : { removedFiles: 0, usage: await measureSessionPhysicalDiskUsage(params.storePath) };
  if (canonical.usage.totalBytes <= params.highWaterBytes) {
    return canonical;
  }
  const legacy = await pruneSessionTranscriptArchivesToHighWater({
    excludeNames: readUnpublishedSessionTranscriptArchiveNames(params.databaseOptions),
    highWaterBytes: params.highWaterBytes,
    storePath: params.storePath,
  });
  return {
    removedFiles: canonical.removedFiles + legacy.removedFiles,
    usage: legacy.usage,
  };
}
