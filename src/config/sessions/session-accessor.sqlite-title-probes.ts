import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
  type SessionSqliteTargetResolutionCache,
} from "./session-accessor.sqlite-scope.js";

type TitleProbeDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "session_transcript_index_state"
  | "session_windows"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
>;

export type SessionTranscriptTitleProbe = {
  generation: string | null;
  head: Array<{ event: TranscriptEvent; seq: number }>;
  maxSeq: number | null;
  tail: Array<{ event: TranscriptEvent; seq: number }>;
  totalMessages: number;
};

const SESSION_TITLE_PROBE_MESSAGES = 20;
const SESSION_TITLE_PROBE_QUERY_CHUNK_SIZE = 400;

function getTitleProbeKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<TitleProbeDatabase>(database.db);
}

function parseEventType(eventJson: string | null): string | undefined {
  if (!eventJson) {
    return undefined;
  }
  try {
    const event = JSON.parse(eventJson) as { type?: unknown };
    return typeof event.type === "string" ? event.type : undefined;
  } catch {
    return undefined;
  }
}

function sqliteTranscriptBoundaryEventType() {
  return /* kysely-allow-raw: boundary type lives inside canonical transcript JSON. */ sql<string>`json_extract(boundary_event.event_json, '$.type')`;
}

function readTitleProbeChunk(
  database: OpenClawAgentDatabase,
  sessionIds: readonly string[],
): Map<string, SessionTranscriptTitleProbe> {
  const db = getTitleProbeKysely(database);
  const rows = runSqliteDeferredTransactionSync(
    database.db,
    () =>
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_windows as window")
          .leftJoin(
            "session_transcript_index_state as state",
            "state.session_id",
            "window.session_id",
          )
          .leftJoin(
            "transcript_rewrite_watermarks as rewrite",
            "rewrite.session_id",
            "window.session_id",
          )
          .leftJoin("session_transcript_active_events as active", (join) =>
            join
              .onRef("active.session_id", "=", "window.session_id")
              .on("active.message_position", "is not", null)
              .on((eb) =>
                eb.or([
                  eb("active.message_position", "<", SESSION_TITLE_PROBE_MESSAGES),
                  eb(
                    "active.message_position",
                    ">=",
                    eb("state.active_message_count", "-", SESSION_TITLE_PROBE_MESSAGES),
                  ),
                ]),
              ),
          )
          .leftJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select((eb) => [
            "window.session_id",
            "state.active_message_count",
            "state.indexed_seq",
            "state.needs_rebuild",
            "rewrite.generation",
            "active.message_position",
            "event.event_json",
            eb
              .selectFrom("transcript_events as latest")
              .select("latest.seq")
              .whereRef("latest.session_id", "=", "window.session_id")
              .orderBy("latest.seq", "desc")
              .limit(1)
              .as("latest_seq"),
            eb
              .selectFrom("session_transcript_active_events as boundary")
              .innerJoin("transcript_events as boundary_event", (join) =>
                join
                  .onRef("boundary_event.session_id", "=", "boundary.session_id")
                  .onRef("boundary_event.seq", "=", "boundary.event_seq"),
              )
              .select("boundary_event.event_json")
              .whereRef("boundary.session_id", "=", "window.session_id")
              .where("boundary.message_position", "is", null)
              // excluding latest-reset sessions prevents pre-reset text from leaking.
              .where(sqliteTranscriptBoundaryEventType(), "in", ["reset", "compaction"])
              .orderBy("boundary.active_position", "desc")
              .limit(1)
              .as("latest_boundary_json"),
          ])
          .where("window.session_id", "in", sessionIds)
          .orderBy("window.session_id", "asc")
          .orderBy("active.message_position", "asc"),
      ).rows,
    { databaseLabel: database.path, operationLabel: "sessions.list.title-probes" },
  );
  const probes = new Map<string, SessionTranscriptTitleProbe>();
  for (const row of rows) {
    const emptyTranscript = row.latest_seq === null;
    const projectionCurrent = row.needs_rebuild === 0 && row.indexed_seq === row.latest_seq;
    if (
      (!emptyTranscript && !projectionCurrent) ||
      parseEventType(row.latest_boundary_json) === "reset"
    ) {
      continue;
    }
    const totalMessages = row.active_message_count ?? 0;
    const probe = probes.get(row.session_id) ?? {
      generation: row.generation ?? null,
      head: [],
      maxSeq: row.latest_seq ?? null,
      tail: [],
      totalMessages,
    };
    if (row.event_json !== null && row.message_position !== null) {
      const event = {
        event: JSON.parse(row.event_json) as TranscriptEvent,
        seq: row.message_position + 1,
      };
      if (row.message_position < SESSION_TITLE_PROBE_MESSAGES) {
        probe.head.push(event);
      }
      if (row.message_position >= totalMessages - SESSION_TITLE_PROBE_MESSAGES) {
        probe.tail.push(event);
      }
    }
    probes.set(row.session_id, probe);
  }
  return probes;
}

/** Reads bounded title probes in one statement per opened store (chunked for SQLite limits). */
export function readSessionTranscriptTitleProbeBatch(
  scopes: readonly SessionTranscriptReadScope[],
): Array<SessionTranscriptTitleProbe | undefined> {
  const results: Array<SessionTranscriptTitleProbe | undefined> = Array.from({
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
    const probes = new Map<string, SessionTranscriptTitleProbe>();
    for (
      let offset = 0;
      offset < sessionIds.length;
      offset += SESSION_TITLE_PROBE_QUERY_CHUNK_SIZE
    ) {
      const chunk = sessionIds.slice(offset, offset + SESSION_TITLE_PROBE_QUERY_CHUNK_SIZE);
      for (const [sessionId, probe] of readTitleProbeChunk(group.database, chunk)) {
        probes.set(sessionId, probe);
      }
    }
    for (const item of group.items) {
      results[item.index] = probes.get(item.sessionId);
    }
  }
  return results;
}
