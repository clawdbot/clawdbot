import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptEventRow,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";

/** Loads one raw suffix only after SQL-side row and byte bounds are proven. */
export function loadTranscriptSuffixEventsBoundedSync(
  scope: SessionTranscriptReadScope,
  startSeq: number,
  limits: { maxBytes: number; maxEvents: number },
): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getSessionKysely(database.db);
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      if (fence) {
        const hiddenSuffix = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_events")
            .select("seq")
            .where("session_id", "=", resolved.sessionId)
            .where("seq", ">=", fence.beforeRawSeq)
            .limit(1),
        );
        if (hiddenSuffix) {
          throw new SessionTranscriptReadFenceError(
            `Current-turn transcript admission hides rows needed for suffix mutation: ${fence.admission.entryId}`,
          );
        }
      }
      const metadata = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select([
            "seq",
            /* kysely-allow-raw: reject oversized suffixes before acquiring their JSON payloads. */
            sql<number>`OCTET_LENGTH(event_json) + 1`.as("serialized_bytes"),
          ])
          .where("session_id", "=", resolved.sessionId)
          .where("seq", ">=", startSeq)
          .orderBy("seq", "asc")
          .limit(limits.maxEvents + 1),
      ).rows;
      if (metadata.length > limits.maxEvents) {
        throw new Error(
          `Transcript suffix exceeds synchronous planning row limit for ${resolved.sessionId}`,
        );
      }
      let bytes = 0;
      for (const row of metadata) {
        bytes += row.serialized_bytes;
        if (bytes > limits.maxBytes) {
          throw new Error(
            `Transcript suffix exceeds synchronous planning byte limit for ${resolved.sessionId}`,
          );
        }
      }
      if (metadata.length === 0) {
        return [];
      }
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select(["event_json", "seq"])
          .where("session_id", "=", resolved.sessionId)
          .where(
            "seq",
            "in",
            metadata.map((row) => row.seq),
          )
          .orderBy("seq", "asc"),
      ).rows;
      if (
        rows.length !== metadata.length ||
        rows.some((row, index) => row.seq !== metadata[index]?.seq)
      ) {
        throw new Error(`SQLite transcript changed while reading suffix for ${resolved.sessionId}`);
      }
      // SAFETY: Raw transcript rows are parsed through the persisted transcript event union.
      return rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent);
    },
    {
      databaseLabel: database.path,
      operationLabel: "bounded transcript suffix read",
    },
  );
}

/** Reads the nearest indexed event before a raw transcript sequence. */
export function readPreviousIndexedTranscriptEventSync(
  scope: SessionTranscriptReadScope,
  beforeSeq: number,
): SessionTranscriptEventRow | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "identity.session_id")
          .onRef("event.seq", "=", "identity.seq"),
      )
      .select(["event.event_json", "identity.seq"])
      .where("identity.session_id", "=", resolved.sessionId)
      .where("identity.seq", "<", beforeSeq)
      .where("identity.event_type", "in", [
        "message",
        "thinking_level_change",
        "model_change",
        "compaction",
        "reset",
        "branch_summary",
        "custom",
        "custom_message",
        "label",
        "session_info",
      ])
      .orderBy("identity.seq", "desc")
      .limit(1),
  );
  return row
    ? {
        // SAFETY: Indexed transcript rows contain the persisted transcript event union.
        event: JSON.parse(row.event_json) as TranscriptEvent,
        seq: sqliteNumber(row.seq),
      }
    : undefined;
}
