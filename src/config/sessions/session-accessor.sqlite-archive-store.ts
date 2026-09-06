import fs from "node:fs";
import path from "node:path";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import {
  resolveRegisteredSqliteTranscriptArchiveName,
  runSqliteTranscriptArchivePublishWorker,
  type MaterializedSessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";

/** Inserts the canonical archive row inside the lifecycle deletion transaction. */
export function persistSessionTranscriptArchive(
  database: OpenClawAgentDatabase,
  plan: MaterializedSessionStateDeletePlan,
): void {
  const archive = plan.archive;
  const generation = plan.snapshot.generation;
  const sessionKey = plan.snapshot.sessionKey;
  if (!archive || !generation || !sessionKey) {
    throw new Error(
      `Cannot persist SQLite transcript archive without an owner generation for ${plan.sessionId}`,
    );
  }
  ensureSessionTranscriptArchiveSchema(database.db);
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_transcript_archives")
      .values({
        archive_blob: archive.bytes,
        archive_name: archive.archiveName,
        archive_sha256: archive.sha256,
        created_at: archive.createdAt,
        encoding: archive.encoding,
        generation,
        last_publish_attempt_at: null,
        last_publish_error: null,
        published_at: null,
        reason: plan.reason,
        session_id: plan.sessionId,
        session_key: sessionKey,
      })
      .onConflict((conflict) => conflict.columns(["session_id", "generation"]).doNothing()),
  );
  const persisted = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_archives")
      .select([
        "archive_blob",
        "archive_name",
        "archive_sha256",
        "created_at",
        "encoding",
        "reason",
        "session_key",
      ])
      .where("session_id", "=", plan.sessionId)
      .where("generation", "=", generation),
  );
  if (
    !persisted ||
    persisted.archive_name !== archive.archiveName ||
    persisted.archive_sha256 !== archive.sha256 ||
    persisted.created_at !== archive.createdAt ||
    persisted.encoding !== archive.encoding ||
    persisted.reason !== plan.reason ||
    persisted.session_key !== sessionKey ||
    !Buffer.from(persisted.archive_blob).equals(Buffer.from(archive.bytes))
  ) {
    throw new Error(`Conflicting SQLite transcript archive for ${plan.sessionId}`);
  }
}

const PENDING_ARCHIVE_PUBLISH_BATCH_SIZE = 4;

// Composite map keys keep repeated physical IDs distinct across transcript rewrites.
function transcriptArchiveIdentityKey(sessionId: string, generation: string): string {
  return `${sessionId}\u0000${generation}`;
}

// Retain one publication plan per immutable archive identity.
function uniqueTranscriptArchives<T extends { generation: string; sessionId: string }>(
  archives: readonly T[],
): T[] {
  return [
    ...new Map(
      archives.map((archive) => [
        transcriptArchiveIdentityKey(archive.sessionId, archive.generation),
        archive,
      ]),
    ).values(),
  ];
}

/** Publishes derived archive files after their canonical rows and deletions commit. */
export async function publishSessionStateArchives(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  requested: readonly SessionLifecycleArchivedTranscript[],
): Promise<SessionLifecycleArchivedTranscript[]> {
  const requestedArchives = uniqueTranscriptArchives(requested);
  const requestedIdentitySet = new Set(
    requestedArchives.map((archive) =>
      transcriptArchiveIdentityKey(archive.sessionId, archive.generation),
    ),
  );
  let includeRequested = true;
  while (true) {
    const plans = await runExclusiveSqliteSessionWrite(scope, async () => {
      const database = openOpenClawAgentDatabase(toDatabaseOptions(scope));
      const db = getSessionKysely(database.db);
      if (includeRequested && requestedArchives.length > 0) {
        ensureSessionTranscriptArchiveSchema(database.db);
      } else {
        const exists = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("sqlite_schema")
            .select("name")
            .where("type", "=", "table")
            .where("name", "=", "session_transcript_archives"),
        );
        if (!exists) {
          return [];
        }
      }
      const pendingArchives = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_archives")
          .select(["archive_name", "created_at", "encoding", "generation", "reason", "session_id"])
          .where("published_at", "is", null)
          .orderBy("created_at", "asc")
          .orderBy("session_id", "asc")
          .orderBy("generation", "asc")
          .limit(PENDING_ARCHIVE_PUBLISH_BATCH_SIZE),
      ).rows;
      for (const archive of pendingArchives) {
        if (
          (archive.encoding !== "identity" && archive.encoding !== "zstd") ||
          (archive.reason !== "deleted" && archive.reason !== "reset")
        ) {
          throw new Error(`Invalid pending SQLite transcript archive for ${archive.session_id}`);
        }
        // Stable builds could commit an oversized raw name before file publication.
        // Only pending rows can change names without orphaning a published file.
        const archiveName = resolveRegisteredSqliteTranscriptArchiveName({
          createdAt: archive.created_at,
          encoding: archive.encoding,
          generation: archive.generation,
          reason: archive.reason,
          sessionId: archive.session_id,
        });
        if (archiveName === archive.archive_name) {
          continue;
        }
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("session_transcript_archives")
            .set({ archive_name: archiveName })
            .where("session_id", "=", archive.session_id)
            .where("generation", "=", archive.generation)
            .where("published_at", "is", null),
        );
      }
      const archives = uniqueTranscriptArchives([
        ...(includeRequested ? requestedArchives : []),
        ...pendingArchives.map((archive) => ({
          generation: archive.generation,
          sessionId: archive.session_id,
        })),
      ]);
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(scope);
      return archives.map((archive) => ({
        agentId: database.agentId,
        archiveDirectory,
        databasePath: database.path,
        generation: archive.generation,
        sessionId: archive.sessionId,
      }));
    });
    includeRequested = false;
    if (plans.length === 0) {
      break;
    }

    const results = await runSqliteTranscriptArchivePublishWorker(plans);
    await runExclusiveSqliteSessionWrite(scope, async () => {
      const now = Date.now();
      runOpenClawAgentWriteTransaction((transactionDb) => {
        ensureSessionTranscriptArchiveSchema(transactionDb.db);
        const db = getSessionKysely(transactionDb.db);
        for (const result of results) {
          executeSqliteQuerySync(
            transactionDb.db,
            db
              .updateTable("session_transcript_archives")
              .set((eb) => ({
                last_publish_attempt_at: now,
                last_publish_error: result.error?.slice(0, 1024) ?? null,
                publish_attempts: eb("publish_attempts", "+", 1),
                ...(result.archivedPath ? { published_at: now } : {}),
              }))
              .where("session_id", "=", result.sessionId)
              .where("generation", "=", result.generation),
          );
        }
      }, toDatabaseOptions(scope));
    });

    const planByIdentity = new Map(
      plans.map((plan) => [transcriptArchiveIdentityKey(plan.sessionId, plan.generation), plan]),
    );
    emitArchivedTranscriptUpdates(
      results.flatMap((result) => {
        const identity = transcriptArchiveIdentityKey(result.sessionId, result.generation);
        if (!result.archivedPath || requestedIdentitySet.has(identity)) {
          return [];
        }
        const plan = planByIdentity.get(identity);
        return plan
          ? [
              {
                archivedPath: result.archivedPath,
                generation: result.generation,
                sessionId: result.sessionId,
                sourcePath: path.join(plan.archiveDirectory, `${result.sessionId}.jsonl`),
              },
            ]
          : [];
      }),
    );
    const failedIds = results.flatMap((result) => (result.archivedPath ? [] : [result.sessionId]));
    if (failedIds.length > 0) {
      throw new Error(
        `Session deletion committed, but ${failedIds.length} transcript archive file export(s) remain pending in SQLite; retry the operation to publish them.`,
      );
    }
  }
  return [...requested];
}

const ARCHIVE_RETENTION_BATCH_SIZE = 256;

/** Removes canonical rows only after retention has removed their derived files. */
export async function prunePublishedSessionArchivesByRetention(params: {
  nowMs?: number;
  rules: readonly { olderThanMs: number; reason: "deleted" | "reset" }[];
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">;
}): Promise<number> {
  const rules = new Map(
    params.rules
      .filter((rule) => Number.isFinite(rule.olderThanMs) && rule.olderThanMs >= 0)
      .map((rule) => [rule.reason, rule.olderThanMs] as const),
  );
  if (rules.size === 0) {
    return 0;
  }
  const candidates = await runExclusiveSqliteSessionWrite(params.scope, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(params.scope));
    const db = getSessionKysely(database.db);
    const exists = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "=", "session_transcript_archives"),
    );
    if (!exists) {
      return [];
    }
    return executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select([
          "archive_name",
          "created_at",
          "generation",
          "published_at",
          "reason",
          "session_id",
        ])
        .where("published_at", "is not", null)
        .orderBy("created_at", "asc")
        .orderBy("session_id", "asc")
        .orderBy("generation", "asc")
        .limit(ARCHIVE_RETENTION_BATCH_SIZE),
    ).rows;
  });
  const now = params.nowMs ?? Date.now();
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(params.scope);
  const removable = candidates.filter((row) => {
    const olderThanMs = rules.get(row.reason as "deleted" | "reset");
    if (olderThanMs === undefined || now - row.created_at <= olderThanMs) {
      return false;
    }
    const archivePath = path.resolve(archiveDirectory, row.archive_name);
    return (
      path.dirname(archivePath) === path.resolve(archiveDirectory) &&
      path.basename(archivePath) === row.archive_name &&
      !fs.existsSync(archivePath)
    );
  });
  if (removable.length === 0) {
    return 0;
  }
  return await runExclusiveSqliteSessionWrite(params.scope, async () => {
    let removed = 0;
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const db = getSessionKysely(transactionDb.db);
      for (const row of removable) {
        const result = executeSqliteQuerySync(
          transactionDb.db,
          db
            .deleteFrom("session_transcript_archives")
            .where("session_id", "=", row.session_id)
            .where("generation", "=", row.generation)
            .where("archive_name", "=", row.archive_name)
            .where("created_at", "=", row.created_at)
            .where("published_at", "=", row.published_at),
        );
        removed += Number(result.numAffectedRows ?? 0n);
      }
    }, toDatabaseOptions(params.scope));
    return removed;
  });
}
