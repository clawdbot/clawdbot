import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  readSqliteTranscriptRowsForFork,
  resolveSqliteCheckpointTranscriptForkSources,
} from "./session-accessor.sqlite-checkpoint.js";
import type {
  SessionTranscriptEventRow,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { coerceSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptRetainedMessageNodes,
  selectSessionTranscriptRestorableMessageNodes,
} from "./transcript-tree.js";
import type { SessionCompactionCheckpoint } from "./types.js";

export type SessionTranscriptRestorableMessageSnapshot = {
  artifactRetentionComplete: boolean;
  events: SessionTranscriptEventRow[];
  retainedEvents: SessionTranscriptEventRow[];
  generation: string | null;
  maxSeq: number | null;
  retentionFence: string;
};

/**
 * Every session fact that can turn an unreferenced message back into a retained one.
 *
 * A transcript rewrite and a checkpoint publication commit through separate write
 * paths, so a retention snapshot is only valid while both are unchanged. Destructive
 * callers must revalidate this token at the point of deletion, not just when reading.
 */
function buildSessionTranscriptRetentionFence(params: {
  generation: string | null;
  maxSeq: number | null;
  checkpoints: readonly SessionCompactionCheckpoint[];
}): string {
  const checkpoints = params.checkpoints
    .map((checkpoint) =>
      [
        checkpoint.checkpointId,
        checkpoint.preCompaction.sessionId,
        checkpoint.preCompaction.entryId ?? checkpoint.preCompaction.leafId ?? "",
        checkpoint.preCompaction.sessionFile ? "file" : "",
        checkpoint.postCompaction.sessionId,
        checkpoint.postCompaction.entryId ?? checkpoint.postCompaction.leafId ?? "",
        checkpoint.postCompaction.sessionFile ? "file" : "",
      ].join(":"),
    )
    .toSorted();
  return JSON.stringify([params.generation, params.maxSeq, checkpoints]);
}

/**
 * Reads restorable and artifact-retained branch messages from one SQLite snapshot.
 *
 * Branch/reset policy belongs to the session store; gateway retention callers must
 * not infer it from raw transcript rows.
 */
export function readSessionTranscriptRestorableMessageSnapshot(
  scope: SessionTranscriptReadScope,
): SessionTranscriptRestorableMessageSnapshot {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getSessionKysely(database.db);
      const generation =
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_rewrite_watermarks")
            .select("generation")
            .where("session_id", "=", resolved.sessionId),
        )?.generation ?? null;
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select(["event_json", "seq"])
          .where("session_id", "=", resolved.sessionId)
          .orderBy("seq", "asc"),
      ).rows.map((row) => ({
        event: JSON.parse(row.event_json) as TranscriptEvent,
        seq: coerceSqliteNumber(row.seq),
      }));
      const tree = scanSessionTranscriptTree(rows.map((row) => row.event));
      const retainedEvents = new Map<string, SessionTranscriptEventRow>();
      for (const node of selectSessionTranscriptRetainedMessageNodes(tree)) {
        const row = rows[node.index];
        if (row) {
          retainedEvents.set(`${resolved.sessionId}:${row.seq}`, row);
        }
      }
      const entry = resolved.sessionKey
        ? readSessionEntryRow(database, resolved.sessionKey)?.entry
        : undefined;
      const entryMatchesScope = entry?.sessionId === resolved.sessionId;
      let artifactRetentionComplete = entryMatchesScope;
      if (entryMatchesScope) {
        for (const checkpoint of entry.compactionCheckpoints ?? []) {
          artifactRetentionComplete &&= ![
            checkpoint.preCompaction.sessionFile,
            checkpoint.postCompaction.sessionFile,
          ].some((sessionFile) => Boolean(sessionFile?.trim()));
          for (const source of resolveSqliteCheckpointTranscriptForkSources(checkpoint)) {
            const sourceRows = readSqliteTranscriptRowsForFork(database, source);
            if (sourceRows.status !== "created") {
              artifactRetentionComplete = false;
              continue;
            }
            const sourceTree = scanSessionTranscriptTree(sourceRows.rows.map((row) => row.event));
            for (const node of selectSessionTranscriptRetainedMessageNodes(sourceTree)) {
              const row = sourceRows.rows[node.index];
              if (row) {
                retainedEvents.set(`${source.sessionId}:${row.seq}`, row);
              }
            }
          }
        }
      }
      const maxSeq = rows.at(-1)?.seq ?? null;
      return {
        artifactRetentionComplete,
        events: selectSessionTranscriptRestorableMessageNodes(tree).flatMap(
          (node) => rows[node.index] ?? [],
        ),
        retainedEvents: [...retainedEvents.values()],
        generation,
        maxSeq,
        retentionFence: buildSessionTranscriptRetentionFence({
          generation,
          maxSeq,
          checkpoints: entryMatchesScope ? (entry.compactionCheckpoints ?? []) : [],
        }),
      };
    },
    {
      databaseLabel: database.path,
      operationLabel: "sessions.transcript.restorable-messages.read",
    },
  );
}

/**
 * Reads only the retention fence, for revalidation immediately before an irreversible delete.
 *
 * Deliberately cheaper than the full snapshot: a stale retention decision must be
 * detectable without re-walking every branch and checkpoint source.
 */
export function readSessionTranscriptRetentionFence(scope: SessionTranscriptReadScope): string {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getSessionKysely(database.db);
      const generation =
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_rewrite_watermarks")
            .select("generation")
            .where("session_id", "=", resolved.sessionId),
        )?.generation ?? null;
      const maxSeqValue = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select((eb) => eb.fn.max<number>("seq").as("seq"))
          .where("session_id", "=", resolved.sessionId),
      )?.seq;
      const maxSeq =
        maxSeqValue === undefined || maxSeqValue === null ? null : coerceSqliteNumber(maxSeqValue);
      const entry = resolved.sessionKey
        ? readSessionEntryRow(database, resolved.sessionKey)?.entry
        : undefined;
      return buildSessionTranscriptRetentionFence({
        generation,
        maxSeq,
        checkpoints:
          entry?.sessionId === resolved.sessionId ? (entry.compactionCheckpoints ?? []) : [],
      });
    },
    {
      databaseLabel: database.path,
      operationLabel: "sessions.transcript.retention-fence.read",
    },
  );
}
