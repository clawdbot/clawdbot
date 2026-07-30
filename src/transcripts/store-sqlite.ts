import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
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

function hasExactMeetingTranscriptUtterance(params: {
  database: DatabaseSync;
  metadataJson: string | null;
  sessionId: string;
  sessionStartedAt: string;
  utterance: TranscriptUtterance & { id: string };
}): boolean {
  const db = meetingTranscriptDb(params.database);
  const rows = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("meeting_transcript_utterances")
      .selectAll()
      .where("session_id", "=", params.sessionId)
      .where("session_started_at", "=", params.sessionStartedAt)
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
      sessionId: session.sessionId,
      sessionStartedAt: session.startedAt,
      utterance: { ...utterance, id: utterance.id },
    })
  ) {
    return;
  }
  const stored = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("meeting_transcript_sessions")
      .select("next_utterance_seq")
      .where("session_id", "=", session.sessionId)
      .where("started_at", "=", session.startedAt),
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
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
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
