import { sql } from "kysely";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { PreparedSessionTranscriptProjectionMetadata } from "./session-transcript-projection-rebuild.js";

const SOURCE_FRAME_BYTES = 256 * 1024;

type MemoryTranscriptSnapshot = {
  sessionId: string;
  transcriptUpdatedAt: number | null;
  maxSeq: number;
  generation: string | null;
};

export type MemoryTranscriptProjectionFrame =
  | { type: "source-unavailable" }
  | { type: "source-end"; snapshot: MemoryTranscriptSnapshot }
  | {
      type: "source-frame";
      seq: number;
      createdAt: number;
      bytes: Uint8Array<ArrayBuffer>;
      final: boolean;
    };

function readSnapshot(database: OpenClawAgentDatabase, sessionId: string) {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows as window")
      .leftJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "window.session_id",
      )
      .select((eb) => [
        "window.transcript_updated_at",
        "rewrite.generation",
        eb
          .selectFrom("transcript_events")
          .select("seq")
          .where("session_id", "=", sessionId)
          .orderBy("seq", "desc")
          .limit(1)
          .as("max_seq"),
      ])
      .where("window.session_id", "=", sessionId),
  );
  return row && row.max_seq !== null
    ? {
        sessionId,
        transcriptUpdatedAt: row.transcript_updated_at,
        maxSeq: row.max_seq,
        generation: row.generation,
      }
    : undefined;
}

/** The parent alone owns memory state; a worker receives bytes, never its sentinel path. */
export function createMemoryTranscriptProjectionSource(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
) {
  let snapshot: MemoryTranscriptSnapshot | undefined;
  let afterSeq = -1;
  let offset = 0;
  let row: { seq: number; created_at: number; bytes: Uint8Array } | undefined;
  const assertCurrentOwner = () => {
    if (!database.db.isOpen || getOpenClawAgentDatabaseIfOpen(options) !== database) {
      throw new Error("Incognito transcript database was disposed during reconciliation");
    }
  };
  const snapshotMatches = () => {
    if (!snapshot) {
      return false;
    }
    const current = readSnapshot(database, snapshot.sessionId);
    return (
      current?.generation === snapshot.generation &&
      current?.maxSeq === snapshot.maxSeq &&
      current?.transcriptUpdatedAt === snapshot.transcriptUpdatedAt
    );
  };
  return {
    assertCurrentOwner,
    clear() {
      snapshot = undefined;
      row = undefined;
    },
    isCurrentPlan(plan: PreparedSessionTranscriptProjectionMetadata) {
      return (
        snapshot?.sessionId === plan.sessionId &&
        snapshot.maxSeq === plan.sourceIndexedSeq &&
        snapshot.transcriptUpdatedAt === plan.sourceTranscriptUpdatedAt &&
        snapshotMatches()
      );
    },
    read(sessionId: string): MemoryTranscriptProjectionFrame {
      assertCurrentOwner();
      return runSqliteDeferredTransactionSync(
        database.db,
        () => {
          if (snapshot?.sessionId !== sessionId) {
            snapshot = readSnapshot(database, sessionId);
            row = undefined;
            afterSeq = -1;
            offset = 0;
          }
          if (!snapshotMatches()) {
            row = undefined;
            snapshot = undefined;
            return { type: "source-unavailable" };
          }
          if (!row) {
            row = executeSqliteQueryTakeFirstSync(
              database.db,
              getSessionKysely(database.db)
                .selectFrom("transcript_events")
                .select([
                  "seq",
                  "created_at",
                  /* kysely-allow-raw: acquire UTF-8 once without main-thread decoding or parsing. */
                  sql<Uint8Array>`CAST(event_json AS BLOB)`.as("bytes"),
                ])
                .where("session_id", "=", sessionId)
                .where("seq", ">", afterSeq)
                .orderBy("seq", "asc")
                .limit(1),
            );
            offset = 0;
          }
          if (!row) {
            return { type: "source-end", snapshot: snapshot! };
          }
          // SQLite materializes a full selected value even for SUBSTR. Read once per row;
          // only framing is bounded. The initial native copy still scales with row size.
          const bytes = Uint8Array.from(row.bytes.subarray(offset, offset + SOURCE_FRAME_BYTES));
          offset += bytes.byteLength;
          const frame = {
            type: "source-frame" as const,
            seq: row.seq,
            createdAt: row.created_at,
            bytes,
            final: offset === row.bytes.byteLength,
          };
          if (frame.final) {
            afterSeq = row.seq;
            row = undefined;
          }
          return frame;
        },
        { databaseLabel: database.path, operationLabel: "sessions.transcript-index.memory-source" },
      );
    },
  };
}

export type MemoryTranscriptProjectionSource = ReturnType<
  typeof createMemoryTranscriptProjectionSource
>;
