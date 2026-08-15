// Verifies staged legacy transcript rows against the committed canonical store.
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "@openclaw/normalization-core";
import type { TranscriptUtterance } from "../transcripts/provider-types.js";
import { transcriptSessionSelector, TranscriptsStore } from "../transcripts/store.js";
import {
  LEGACY_UTTERANCE_INSERT_CHUNK_SIZE,
  readStagedMeetingTranscriptUtterances,
  type LegacyMeetingTranscriptSnapshot,
} from "./state-migrations.meeting-transcripts-files.js";

type StoredUtteranceRow = {
  ended_at: string | null;
  final: number | null;
  metadata_json: string | null;
  session_id: string;
  speaker_id: string | null;
  speaker_label: string | null;
  started_at: string | null;
  text: string;
  utterance_id: string | null;
};

function storedUtteranceFromRow(row: StoredUtteranceRow): TranscriptUtterance {
  const utterance: TranscriptUtterance = { sessionId: row.session_id, text: row.text };
  if (row.utterance_id !== null) {
    utterance.id = row.utterance_id;
  }
  if (row.started_at !== null) {
    utterance.startedAt = row.started_at;
  }
  if (row.ended_at !== null) {
    utterance.endedAt = row.ended_at;
  }
  if (row.speaker_label !== null) {
    const speaker: NonNullable<TranscriptUtterance["speaker"]> = { label: row.speaker_label };
    if (row.speaker_id !== null) {
      speaker.id = row.speaker_id;
    }
    utterance.speaker = speaker;
  }
  if (row.final !== null) {
    utterance.final = row.final === 1;
  }
  if (row.metadata_json) {
    utterance.metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  }
  return utterance;
}

export async function verifyImportedMeetingTranscriptSnapshots(params: {
  store: TranscriptsStore;
  snapshots: LegacyMeetingTranscriptSnapshot[];
  stageDatabase: DatabaseSync;
  database: DatabaseSync;
}): Promise<void> {
  const selectUtterances = params.database.prepare(`
    SELECT
      ended_at,
      final,
      metadata_json,
      session_id,
      speaker_id,
      speaker_label,
      started_at,
      text,
      utterance_id
    FROM meeting_transcript_utterances
    WHERE session_id = ? AND session_started_at = ?
    ORDER BY sequence ASC
    LIMIT ? OFFSET ?
  `);
  for (const snapshot of params.snapshots) {
    const session = await params.store.readSession(transcriptSessionSelector(snapshot.session));
    if (!session || stableStringify(session) !== stableStringify(snapshot.session)) {
      throw new Error(`meeting transcript import verification failed: ${snapshot.relativeDir}`);
    }
    for (
      let start = 0;
      start < snapshot.utteranceCount;
      start += LEGACY_UTTERANCE_INSERT_CHUNK_SIZE
    ) {
      const expected = readStagedMeetingTranscriptUtterances({
        stageDatabase: params.stageDatabase,
        stageKey: snapshot.stageKey,
        start,
        limit: LEGACY_UTTERANCE_INSERT_CHUNK_SIZE,
      });
      const actual = selectUtterances
        .all(
          snapshot.session.sessionId,
          snapshot.session.startedAt,
          LEGACY_UTTERANCE_INSERT_CHUNK_SIZE,
          start,
        )
        .map((row) => storedUtteranceFromRow(row as StoredUtteranceRow));
      if (stableStringify(actual) !== stableStringify(expected)) {
        throw new Error(`meeting transcript import verification failed: ${snapshot.relativeDir}`);
      }
    }
    const summary = await params.store.readSummary(session);
    if (
      stableStringify(summary.summary) !== stableStringify(snapshot.summary) ||
      stableStringify(summary.markdown?.trimEnd()) !== stableStringify(snapshot.markdown?.trimEnd())
    ) {
      throw new Error(`meeting transcript summary verification failed: ${snapshot.relativeDir}`);
    }
  }
}
