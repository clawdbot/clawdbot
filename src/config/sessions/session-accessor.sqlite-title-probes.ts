import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSqliteTranscriptStoreBatches } from "./session-accessor.sqlite-scope.js";

type TitleProbeDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "session_transcript_index_state"
  | "session_windows"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
> & {
  transcript_event_identities: OpenClawAgentKyselyDatabase["transcript_event_identities"] & {
    rowid: number;
  };
};

export type SessionTranscriptTitleProbe = {
  generation: string | null;
  head: Array<{ event: TranscriptEvent; seq: number }>;
  maxSeq: number | null;
  tail: Array<{ event: TranscriptEvent; seq: number }>;
  totalMessages: number;
};

const SESSION_TITLE_PROBE_MESSAGES = 20;

function sqliteTitleBoundaryType() {
  // Exact SQLite handoffs can omit identities. Only those rows need their raw JSON;
  // ordinary transcript metadata already has its type in the identity projection.
  return /* kysely-allow-raw: exact imports retain raw events without identity rows. */ sql<string>`coalesce(identity.event_type, json_extract(boundary_event.event_json, '$.type'))`;
}

function readTitleProbeChunk(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionIds: readonly string[],
): Map<string, SessionTranscriptTitleProbe> {
  const db = getNodeSqliteKysely<TitleProbeDatabase>(database.db);
  // Read lifecycle metadata once, without repeating large compaction summaries
  // beside every preview message. Both reads must share the same snapshot.
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const windows = executeSqliteQuerySync(
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
          .select((eb) => [
            "window.session_id",
            "state.active_message_count",
            "state.indexed_seq",
            "state.needs_rebuild",
            "rewrite.generation",
            eb
              .selectFrom("transcript_events as latest")
              .select("latest.seq")
              .whereRef("latest.session_id", "=", "window.session_id")
              .orderBy("latest.seq", "desc")
              .limit(1)
              .as("latest_seq"),
            eb
              .selectFrom("session_transcript_active_events as boundary")
              .leftJoin("transcript_event_identities as identity", (join) =>
                // Resolve a covered sequence key first: directly joining while selecting type
                // can make SQLite scan its type index once per metadata row.
                join.on("identity.rowid", "=", (lookup) =>
                  lookup
                    .selectFrom("transcript_event_identities as identity_key")
                    .select("identity_key.rowid")
                    .whereRef("identity_key.session_id", "=", "boundary.session_id")
                    .whereRef("identity_key.seq", "=", "boundary.event_seq")
                    .limit(1),
                ),
              )
              .leftJoin("transcript_events as boundary_event", (join) =>
                join
                  .onRef("boundary_event.session_id", "=", "boundary.session_id")
                  .onRef("boundary_event.seq", "=", "boundary.event_seq")
                  .on("identity.event_type", "is", null),
              )
              .select(sqliteTitleBoundaryType().as("event_type"))
              .whereRef("boundary.session_id", "=", "window.session_id")
              .where("boundary.message_position", "is", null)
              // Excluding latest-reset sessions prevents pre-reset text from leaking.
              .where(sqliteTitleBoundaryType(), "in", ["reset", "compaction"])
              .orderBy("boundary.active_position", "desc")
              .limit(1)
              .as("latest_boundary_type"),
          ])
          .where("window.session_id", "in", sessionIds),
      ).rows;
      const probes = new Map<string, SessionTranscriptTitleProbe>();
      for (const row of windows) {
        const emptyTranscript = row.latest_seq === null;
        const projectionCurrent = row.needs_rebuild === 0 && row.indexed_seq === row.latest_seq;
        if ((!emptyTranscript && !projectionCurrent) || row.latest_boundary_type === "reset") {
          continue;
        }
        probes.set(row.session_id, {
          generation: row.generation ?? null,
          head: [],
          maxSeq: row.latest_seq ?? null,
          tail: [],
          totalMessages: row.active_message_count ?? 0,
        });
      }
      if (probes.size === 0) {
        return probes;
      }
      // CROSS JOIN keeps selected sessions outside the indexed head/tail seeks.
      const edge = db
        .selectFrom("session_transcript_index_state as state")
        .crossJoin("session_transcript_active_events as active")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .select(["state.session_id", "active.message_position", "event.event_json"])
        .where("state.session_id", "in", [...probes.keys()])
        .whereRef("active.session_id", "=", "state.session_id")
        .where("active.message_position", "is not", null);
      const rows = executeSqliteQuerySync(
        database.db,
        edge
          .where("active.message_position", "<", SESSION_TITLE_PROBE_MESSAGES)
          .unionAll(
            edge.where("active.message_position", ">=", (eb) =>
              eb.fn<number>("max", [
                eb.val(SESSION_TITLE_PROBE_MESSAGES),
                eb("state.active_message_count", "-", SESSION_TITLE_PROBE_MESSAGES),
              ]),
            ),
          )
          .orderBy("state.session_id", "asc")
          .orderBy("active.message_position", "asc"),
      ).rows;
      for (const row of rows) {
        if (row.message_position === null) {
          continue;
        }
        const probe = probes.get(row.session_id)!;
        const event = {
          event: JSON.parse(row.event_json) as TranscriptEvent,
          seq: row.message_position + 1,
        };
        if (row.message_position < SESSION_TITLE_PROBE_MESSAGES) {
          probe.head.push(event);
        }
        if (row.message_position >= probe.totalMessages - SESSION_TITLE_PROBE_MESSAGES) {
          probe.tail.push(event);
        }
      }
      return probes;
    },
    { databaseLabel: database.path, operationLabel: "sessions.list.title-probes" },
  );
}

/** Reads metadata and bounded title edges in one snapshot, chunked for SQLite limits. */
export function readSessionTranscriptTitleProbeBatch(
  scopes: readonly SessionTranscriptReadScope[],
): Array<SessionTranscriptTitleProbe | undefined> {
  return readSqliteTranscriptStoreBatches(scopes, readTitleProbeChunk);
}
