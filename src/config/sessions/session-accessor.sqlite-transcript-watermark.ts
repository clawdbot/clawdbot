// Transcript watermark reader: the (generation, max seq) token pair that
// validates transcript-derived caches (derived titles, branch summaries).
// Kept apart from the active-events reader so cache validation stays a
// dependency-light import for gateway callers.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
  type SessionSqliteTargetResolutionCache,
} from "./session-accessor.sqlite-scope.js";

type WatermarkDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_windows" | "transcript_events" | "transcript_rewrite_watermarks"
>;

export type SessionTranscriptWatermark = {
  generation: string | null;
  maxSeq: number | null;
};

const SESSION_TRANSCRIPT_WATERMARK_QUERY_CHUNK_SIZE = 400;

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

function readSessionTranscriptWatermarkChunk(
  database: OpenClawAgentDatabase,
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
  const results: Array<SessionTranscriptWatermark | undefined> = Array.from({
    length: scopes.length,
  });
  const groups = new Map<
    string,
    { database: OpenClawAgentDatabase; items: Array<{ index: number; sessionId: string }> }
  >();
  const targetCache: SessionSqliteTargetResolutionCache = new Map();
  for (const [index, scope] of scopes.entries()) {
    const resolved = resolveSqliteTranscriptReadScope(scope, targetCache);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const group = groups.get(database.path) ?? { database, items: [] };
    group.items.push({ index, sessionId: resolved.sessionId });
    groups.set(database.path, group);
  }
  for (const group of groups.values()) {
    const sessionIds = [...new Set(group.items.map((item) => item.sessionId))];
    const watermarks = new Map<string, SessionTranscriptWatermark>();
    for (
      let offset = 0;
      offset < sessionIds.length;
      offset += SESSION_TRANSCRIPT_WATERMARK_QUERY_CHUNK_SIZE
    ) {
      const chunk = sessionIds.slice(
        offset,
        offset + SESSION_TRANSCRIPT_WATERMARK_QUERY_CHUNK_SIZE,
      );
      for (const [sessionId, watermark] of readSessionTranscriptWatermarkChunk(
        group.database,
        chunk,
      )) {
        watermarks.set(sessionId, watermark);
      }
    }
    for (const item of group.items) {
      results[item.index] = watermarks.get(item.sessionId) ?? {
        generation: null,
        maxSeq: null,
      };
    }
  }
  return results.map((result) => result ?? { generation: null, maxSeq: null });
}
