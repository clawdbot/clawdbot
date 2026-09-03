import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { meetingTranscriptDb, sessionFromRow } from "./store-sqlite.js";

export type TranscriptReadEntry = {
  session: TranscriptSessionDescriptor;
  selector: string;
  utteranceCount: number;
  participants: string[];
  hasSummary: boolean;
  overview?: string;
  summarySource?: "model" | "heuristic";
};

export type TranscriptReadOptions = {
  limit: number;
  offset?: number;
  providerId?: string;
  session?: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;
};

/** Two bounded queries, independent of the number of meetings in the page. */
export function queryTranscriptReadEntries(
  database: DatabaseSync,
  options: TranscriptReadOptions,
): TranscriptReadEntry[] {
  const db = meetingTranscriptDb(database);
  let query = db
    .selectFrom("meeting_transcript_sessions as sessions")
    .leftJoin("meeting_transcript_summaries as notes", (join) =>
      join
        .onRef("notes.session_id", "=", "sessions.session_id")
        .onRef("notes.session_started_at", "=", "sessions.started_at"),
    )
    .selectAll("sessions")
    .select((eb) => [
      "notes.session_id as summary_id",
      eb
        .fn<string | null>("json_extract", ["notes.summary_json", eb.val("$.overview")])
        .as("overview"),
      eb
        .fn<string | null>("json_extract", ["notes.summary_json", eb.val("$.source")])
        .as("summary_source"),
    ])
    .orderBy("sessions.started_at", "desc")
    .orderBy("sessions.session_id", "asc")
    .limit(options.limit)
    .offset(options.offset ?? 0);
  if (options.providerId !== undefined) {
    query = query.where("sessions.provider_id", "=", options.providerId);
  }
  if (options.session) {
    query = query
      .where("sessions.session_id", "=", options.session.sessionId)
      .where("sessions.started_at", "=", options.session.startedAt);
  }
  const rows = executeSqliteQuerySync(database, query).rows;
  if (!rows.length) {
    return [];
  }
  // Group on the full capture identity: providers can reuse a session ID tomorrow.
  // NULL-speaker groups still count toward utterance totals.
  const speakers = executeSqliteQuerySync(
    database,
    db
      .selectFrom("meeting_transcript_utterances")
      .select(["session_id", "session_started_at", "speaker_label"])
      .select((eb) => [
        eb.fn.countAll<number>().as("count"),
        eb.fn.min<number>("sequence").as("first"),
      ])
      .where((eb) =>
        eb.or(
          rows.map((row) =>
            eb.and([
              eb("session_id", "=", row.session_id),
              eb("session_started_at", "=", row.started_at),
            ]),
          ),
        ),
      )
      .groupBy(["session_id", "session_started_at", "speaker_label"])
      .orderBy("first", "asc"),
  ).rows;
  const entries = rows.map(
    (row): TranscriptReadEntry => ({
      session: sessionFromRow(row),
      selector: row.selector,
      utteranceCount: 0,
      participants: [],
      hasSummary: row.summary_id !== null,
      overview: typeof row.overview === "string" ? row.overview : undefined,
      summarySource:
        row.summary_source === "model" || row.summary_source === "heuristic"
          ? row.summary_source
          : undefined,
    }),
  );
  const byIdentity = new Map(
    entries.map((entry) => [
      JSON.stringify([entry.session.sessionId, entry.session.startedAt]),
      entry,
    ]),
  );
  for (const speaker of speakers) {
    const entry = byIdentity.get(JSON.stringify([speaker.session_id, speaker.session_started_at]))!;
    entry.utteranceCount += speaker.count;
    if (speaker.speaker_label) {
      entry.participants.push(speaker.speaker_label);
    }
  }
  return entries;
}
