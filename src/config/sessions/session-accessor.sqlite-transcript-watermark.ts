// Transcript watermark reader: the (generation, max seq) token pair that
// validates transcript-derived caches (derived titles, branch summaries).
// Kept apart from the active-events reader so cache validation stays a
// dependency-light import for gateway callers.
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

type WatermarkDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "transcript_events" | "transcript_rewrite_watermarks"
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
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
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
}
