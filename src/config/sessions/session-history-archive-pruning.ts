import fs from "node:fs";
import path from "node:path";
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

export function reclaimSqliteFreePages(databaseOptions: OpenClawAgentDatabaseOptions): void {
  // openclaw-agent-db.ts cache rule: LRU eviction closes idle handles across awaits.
  const database = openOpenClawAgentDatabase(databaseOptions);
  // Committed row deletion first lands in the WAL. TRUNCATE makes that shrink immediately;
  // incremental vacuum can then return free tail pages from the main file without a rewrite.
  database.walMaintenance.checkpoint();
  // SAFETY: SQLite returns this fixed numeric column for PRAGMA freelist_count.
  const row = database.db.prepare("PRAGMA freelist_count").get() as
    | { freelist_count?: unknown }
    | undefined;
  const freePages = Number(row?.freelist_count ?? 0);
  if (Number.isSafeInteger(freePages) && freePages > 0) {
    database.db.exec(`PRAGMA incremental_vacuum(${freePages});`);
  }
  database.walMaintenance.checkpoint();
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
    reclaimSqliteFreePages(params.databaseOptions);
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
  let canonical = {
    removedFiles: 0,
    usage: await measureSessionPhysicalDiskUsage(params.storePath),
  };
  if (hasCanonicalSessionTranscriptArchives(params.databaseOptions)) {
    canonical = await pruneCanonicalSessionTranscriptArchivesToHighWater(params);
  }
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
