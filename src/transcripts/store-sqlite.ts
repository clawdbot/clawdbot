import type { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceLocator,
  TranscriptUtterance,
} from "./provider-types.js";
import {
  safeTranscriptPathSegment,
  transcriptSessionExportKey,
  transcriptSessionSelector,
} from "./store-artifacts.js";
import type { TranscriptsSummary } from "./summary.js";

type MeetingTranscriptsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "meeting_transcript_sessions" | "meeting_transcript_summaries" | "meeting_transcript_utterances"
>;

export type MeetingTranscriptSessionRow = Selectable<
  OpenClawStateKyselyDatabase["meeting_transcript_sessions"]
>;
type MeetingTranscriptSummaryRow = Selectable<
  OpenClawStateKyselyDatabase["meeting_transcript_summaries"]
>;
type MeetingTranscriptUtteranceRow = Selectable<
  OpenClawStateKyselyDatabase["meeting_transcript_utterances"]
>;

export function meetingTranscriptDb(db: DatabaseSync) {
  return getNodeSqliteKysely<MeetingTranscriptsDatabase>(db);
}

export function meetingTranscriptSessionQuery(
  database: DatabaseSync,
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
) {
  return meetingTranscriptDb(database)
    .selectFrom("meeting_transcript_sessions")
    .where("session_id", "=", session.sessionId)
    .where("started_at", "=", session.startedAt);
}

export function writeMeetingTranscriptSession(
  database: DatabaseSync,
  session: TranscriptSessionDescriptor,
  now: number,
): boolean {
  // Admission provenance comes from this writer lock, not an earlier filesystem check.
  const existing = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptSessionQuery(database, session).select("session_id"),
  );
  const sessionValues = {
    selector: transcriptSessionSelector(session),
    export_key: transcriptSessionExportKey(session),
    session_slug: safeTranscriptPathSegment(session.sessionId),
    provider_id: session.source.providerId,
    title: session.title ?? null,
    source_json: JSON.stringify(session.source),
    stopped_at: session.stoppedAt ?? null,
    metadata_json: session.metadata ? JSON.stringify(session.metadata) : null,
  };
  executeSqliteQuerySync(
    database,
    meetingTranscriptDb(database)
      .insertInto("meeting_transcript_sessions")
      .values({
        session_id: session.sessionId,
        started_at: session.startedAt,
        ...sessionValues,
        export_manifest_json: "{}",
        export_pending_json: "[]",
        next_utterance_seq: 0,
        created_at_ms: now,
        updated_at_ms: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["session_id", "started_at"]).doUpdateSet({
          ...sessionValues,
          updated_at_ms: now,
        }),
      ),
  );
  return existing === undefined;
}

export function deleteEmptyMeetingTranscriptCandidate(
  database: DatabaseSync,
  session: TranscriptSessionDescriptor,
): void {
  const stored = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptSessionQuery(database, session).selectAll(),
  );
  // Failed-start cleanup cannot consume rewritten history, notes, or exported artifacts.
  if (
    !stored ||
    stored.stopped_at !== (session.stoppedAt ?? null) ||
    stored.source_json !== JSON.stringify(session.source) ||
    stored.title !== (session.title ?? null) ||
    stored.metadata_json !== (session.metadata ? JSON.stringify(session.metadata) : null) ||
    stored.next_utterance_seq !== 0 ||
    stored.export_manifest_json !== "{}" ||
    stored.export_pending_json !== "[]"
  ) {
    return;
  }
  const db = meetingTranscriptDb(database);
  executeSqliteQuerySync(
    database,
    db
      .deleteFrom("meeting_transcript_sessions")
      .where("session_id", "=", session.sessionId)
      .where("started_at", "=", session.startedAt)
      .where((eb) =>
        eb.not(
          eb.exists(
            db
              .selectFrom("meeting_transcript_summaries")
              .select("session_id")
              .where("session_id", "=", session.sessionId)
              .where("session_started_at", "=", session.startedAt),
          ),
        ),
      ),
  );
}

export function readTranscriptSummaryInputRevision(
  database: DatabaseSync,
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
): string | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptSessionQuery(database, session).select([
      "next_utterance_seq",
      "title",
      "source_json",
      "metadata_json",
      "stopped_at",
    ]),
  );
  // Export bookkeeping is not summary input and must not invalidate a reader.
  return row ? JSON.stringify(row) : undefined;
}

export function readRecentStoppedTranscriptSession(
  database: DatabaseSync,
  source: TranscriptSourceLocator,
  stoppedAfter: string,
  stoppedBefore: string,
): TranscriptSessionDescriptor | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptDb(database)
      .selectFrom("meeting_transcript_sessions")
      .selectAll()
      .where("provider_id", "=", source.providerId)
      .where("stopped_at", ">=", stoppedAfter)
      .where("stopped_at", "<=", stoppedBefore)
      .where((eb) =>
        eb.and(
          (["accountId", "guildId", "channelId", "meetingUrl", "threadTs", "fileId"] as const).map(
            (key) =>
              eb(
                eb.fn<string | null>("json_extract", [eb.ref("source_json"), eb.val(`$.${key}`)]),
                source[key] === undefined ? "is" : "=",
                source[key] ?? null,
              ),
          ),
        ),
      )
      .orderBy("stopped_at", "desc")
      .orderBy("started_at", "desc")
      .orderBy("session_id", "asc")
      .limit(1),
  );
  return row ? sessionFromRow(row) : undefined;
}

export function meetingTranscriptUtteranceQuery(
  database: DatabaseSync,
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
) {
  return meetingTranscriptDb(database)
    .selectFrom("meeting_transcript_utterances")
    .where("session_id", "=", session.sessionId)
    .where("session_started_at", "=", session.startedAt);
}

function hasExactMeetingTranscriptUtterance(params: {
  database: DatabaseSync;
  metadataJson: string | null;
  session: TranscriptSessionDescriptor;
  utterance: TranscriptUtterance & { id: string };
}): boolean {
  const rows = executeSqliteQuerySync(
    params.database,
    meetingTranscriptUtteranceQuery(params.database, params.session)
      .selectAll()
      .where("utterance_id", "=", params.utterance.id),
  ).rows;
  const utterance = params.utterance;
  return rows.some(
    (row) =>
      row.started_at === (utterance.startedAt ?? null) &&
      row.ended_at === (utterance.endedAt ?? null) &&
      row.speaker_id === (utterance.speaker?.id ?? null) &&
      row.speaker_label === (utterance.speaker?.label ?? null) &&
      row.text === utterance.text &&
      row.final === (utterance.final === undefined ? null : utterance.final ? 1 : 0) &&
      row.metadata_json === params.metadataJson,
  );
}

export function appendMeetingTranscriptUtterance(params: {
  database: DatabaseSync;
  metadataJson: string | null;
  now: number;
  session: TranscriptSessionDescriptor;
  utterance: TranscriptUtterance;
}): void {
  const { database, session, utterance } = params;
  const db = meetingTranscriptDb(database);
  if (
    utterance.id &&
    hasExactMeetingTranscriptUtterance({
      database,
      metadataJson: params.metadataJson,
      session,
      utterance: { ...utterance, id: utterance.id },
    })
  ) {
    return;
  }
  const stored = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptSessionQuery(database, session).select("next_utterance_seq"),
  );
  if (!stored) {
    throw new Error(`transcripts session not found: ${session.sessionId}`);
  }
  const sequence = stored.next_utterance_seq;
  executeSqliteQuerySync(
    database,
    db.insertInto("meeting_transcript_utterances").values({
      session_id: session.sessionId,
      session_started_at: session.startedAt,
      sequence,
      utterance_id: utterance.id ?? null,
      started_at: utterance.startedAt ?? null,
      ended_at: utterance.endedAt ?? null,
      speaker_id: utterance.speaker?.id ?? null,
      speaker_label: utterance.speaker?.label ?? null,
      text: utterance.text,
      final: utterance.final === undefined ? null : utterance.final ? 1 : 0,
      metadata_json: params.metadataJson,
    }),
  );
  executeSqliteQuerySync(
    database,
    db
      .updateTable("meeting_transcript_sessions")
      .set({ next_utterance_seq: sequence + 1, updated_at_ms: params.now })
      .where("session_id", "=", session.sessionId)
      .where("started_at", "=", session.startedAt),
  );
}

function parseOptionalJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return asOptionalRecord(JSON.parse(value));
}

export function sessionFromRow(row: MeetingTranscriptSessionRow): TranscriptSessionDescriptor {
  const source = parseOptionalJsonRecord(row.source_json);
  const metadata = parseOptionalJsonRecord(row.metadata_json);
  if (!source || typeof source.providerId !== "string") {
    throw new Error(`invalid meeting transcript source for ${row.session_id}`);
  }
  return {
    sessionId: row.session_id,
    source: source as TranscriptSessionDescriptor["source"],
    startedAt: row.started_at,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.stopped_at !== null ? { stoppedAt: row.stopped_at } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function utteranceFromRow(row: MeetingTranscriptUtteranceRow): TranscriptUtterance {
  const speaker =
    row.speaker_label !== null
      ? {
          label: row.speaker_label,
          ...(row.speaker_id !== null ? { id: row.speaker_id } : {}),
        }
      : undefined;
  const metadata = parseOptionalJsonRecord(row.metadata_json);
  return {
    sessionId: row.session_id,
    text: row.text,
    ...(row.utterance_id !== null ? { id: row.utterance_id } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(speaker ? { speaker } : {}),
    ...(row.final === null ? {} : { final: row.final === 1 }),
    ...(metadata ? { metadata } : {}),
  };
}

export function summaryFromRow(row: MeetingTranscriptSummaryRow): TranscriptsSummary | undefined {
  return row.summary_json ? (JSON.parse(row.summary_json) as TranscriptsSummary) : undefined;
}
