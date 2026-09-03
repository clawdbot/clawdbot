// Transcript watermark reader: the (generation, max seq) token pair that
// validates transcript-derived caches (derived titles, branch summaries).
// Kept apart from the active-events reader so cache validation stays a
// dependency-light import for gateway callers.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  readSqliteTranscriptStoreBatches,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

type WatermarkDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_windows" | "transcript_events" | "transcript_rewrite_watermarks"
>;

export type SessionTranscriptWatermark = {
  generation: string | null;
  maxSeq: number | null;
};

/** Reads the append and rewrite tokens that validate transcript-derived caches. */
export function readSessionTranscriptWatermark(
  scope: SessionTranscriptReadScope,
): SessionTranscriptWatermark {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const db = getNodeSqliteKysely<WatermarkDatabase>(database.db);
      const maxSeq = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select((eb) => eb.fn.max<number>("seq").as("max_seq"))
          .where("session_id", "=", resolved.sessionId),
      )?.max_seq;
      const generation = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_rewrite_watermarks")
          .select("generation")
          .where("session_id", "=", resolved.sessionId),
      )?.generation;
      return { generation: generation ?? null, maxSeq: maxSeq ?? null };
    },
    toDatabaseOptions(resolved),
    { throwOnMissingTable: true },
  );
  return result.found ? result.value : { generation: null, maxSeq: null };
}

function readSessionTranscriptWatermarkChunk(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionIds: readonly string[],
): Map<string, SessionTranscriptWatermark> {
  const db = getNodeSqliteKysely<WatermarkDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows as window")
      .leftJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "window.session_id",
      )
      .select((eb) => [
        "window.session_id",
        "rewrite.generation",
        eb
          .selectFrom("transcript_events as event")
          .select((inner) => inner.fn.max<number>("event.seq").as("max_seq"))
          .whereRef("event.session_id", "=", "window.session_id")
          .as("max_seq"),
      ])
      .where("window.session_id", "in", sessionIds),
  ).rows;
  return new Map(
    rows.map((row) => [
      row.session_id,
      {
        generation: row.generation ?? null,
        maxSeq: row.max_seq ?? null,
      },
    ]),
  );
}

/** Reads cache-validation tokens in one statement per opened store and SQLite-sized chunk. */
export function readSessionTranscriptWatermarkBatch(
  scopes: readonly SessionTranscriptReadScope[],
): SessionTranscriptWatermark[] {
  return readSqliteTranscriptStoreBatches(scopes, readSessionTranscriptWatermarkChunk).map(
    (result) => result ?? { generation: null, maxSeq: null },
  );
}
