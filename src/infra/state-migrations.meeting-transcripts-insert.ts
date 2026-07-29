import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  safeTranscriptPathSegment,
  transcriptSessionExportKey,
  transcriptSessionSelector,
} from "../transcripts/store.js";
import { sha256Hex } from "./crypto-digest.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { migrationDb } from "./state-migrations.meeting-transcripts-database.js";
import {
  LEGACY_UTTERANCE_INSERT_CHUNK_SIZE,
  readStagedMeetingTranscriptUtterances,
  type LegacyMeetingTranscriptSnapshot,
} from "./state-migrations.meeting-transcripts-files.js";

function sourceKey(sourceDir: string): string {
  return `meeting-transcripts:${sha256Hex(path.resolve(sourceDir))}`;
}

export function insertMeetingTranscriptSnapshots(params: {
  snapshots: LegacyMeetingTranscriptSnapshot[];
  runId: string;
  now: number;
  archiveRoot: string;
  canonicalRelativeDirs: string[];
  stageDatabase: DatabaseSync;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): void {
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      const db = migrationDb(database);
      // Run-wide metadata is stored once here; per-source receipts below keep
      // only their selector so large migrations remain linear in session count.
      executeSqliteQuerySync(
        database,
        db.insertInto("migration_runs").values({
          id: params.runId,
          started_at: params.now,
          finished_at: null,
          status: "imported",
          report_json: JSON.stringify({
            format: "meeting-transcripts-files-v1",
            sessions: params.snapshots.length,
            utterances: params.snapshots.reduce(
              (total, snapshot) => total + snapshot.utteranceCount,
              0,
            ),
            archiveRoot: params.archiveRoot,
            canonicalRelativeDirs: params.canonicalRelativeDirs,
          }),
        }),
      );
      for (const snapshot of params.snapshots) {
        executeSqliteQuerySync(
          database,
          db.insertInto("meeting_transcript_sessions").values({
            session_id: snapshot.session.sessionId,
            started_at: snapshot.session.startedAt,
            selector: transcriptSessionSelector(snapshot.session),
            export_key: transcriptSessionExportKey(snapshot.session),
            session_slug: safeTranscriptPathSegment(snapshot.session.sessionId),
            provider_id: snapshot.session.source.providerId,
            title: snapshot.session.title ?? null,
            source_json: JSON.stringify(snapshot.session.source),
            stopped_at: snapshot.session.stoppedAt ?? null,
            metadata_json: snapshot.session.metadata
              ? JSON.stringify(snapshot.session.metadata)
              : null,
            export_manifest_json: "{}",
            export_pending_json: "[]",
            next_utterance_seq: snapshot.utteranceCount,
            created_at_ms: params.now,
            updated_at_ms: params.now,
          }),
        );
        if (snapshot.utteranceCount > 0) {
          for (
            let start = 0;
            start < snapshot.utteranceCount;
            start += LEGACY_UTTERANCE_INSERT_CHUNK_SIZE
          ) {
            const chunk = readStagedMeetingTranscriptUtterances({
              stageDatabase: params.stageDatabase,
              stageKey: snapshot.stageKey,
              start,
              limit: LEGACY_UTTERANCE_INSERT_CHUNK_SIZE,
            });
            executeSqliteQuerySync(
              database,
              db.insertInto("meeting_transcript_utterances").values(
                chunk.map((utterance, offset) => ({
                  session_id: snapshot.session.sessionId,
                  session_started_at: snapshot.session.startedAt,
                  sequence: start + offset,
                  utterance_id: utterance.id ?? null,
                  started_at: utterance.startedAt ?? null,
                  ended_at: utterance.endedAt ?? null,
                  speaker_id: utterance.speaker?.id ?? null,
                  speaker_label: utterance.speaker?.label ?? null,
                  text: utterance.text,
                  final: utterance.final === undefined ? null : utterance.final ? 1 : 0,
                  metadata_json: utterance.metadata ? JSON.stringify(utterance.metadata) : null,
                })),
              ),
            );
          }
        }
        if (snapshot.summary !== undefined || snapshot.markdown !== undefined) {
          executeSqliteQuerySync(
            database,
            db.insertInto("meeting_transcript_summaries").values({
              session_id: snapshot.session.sessionId,
              session_started_at: snapshot.session.startedAt,
              generated_at: snapshot.summary?.generatedAt ?? null,
              summary_json: snapshot.summary ? JSON.stringify(snapshot.summary) : null,
              markdown: snapshot.markdown ?? null,
              utterance_count: snapshot.summary?.utteranceCount ?? snapshot.utteranceCount,
            }),
          );
        }
        executeSqliteQuerySync(
          database,
          db
            .insertInto("migration_sources")
            .values({
              source_key: sourceKey(snapshot.sourceDir),
              migration_kind: "meeting-transcripts-files-v1",
              source_path: snapshot.sourceDir,
              target_table: "meeting_transcript_sessions",
              source_sha256: snapshot.sourceHash,
              source_size_bytes: snapshot.sourceSizeBytes,
              source_record_count: snapshot.utteranceCount,
              last_run_id: params.runId,
              status: "imported",
              imported_at: params.now,
              removed_source: 0,
              report_json: JSON.stringify({
                selector: transcriptSessionSelector(snapshot.session),
              }),
            })
            .onConflict((conflict) =>
              conflict.column("source_key").doUpdateSet({
                source_sha256: snapshot.sourceHash,
                source_size_bytes: snapshot.sourceSizeBytes,
                source_record_count: snapshot.utteranceCount,
                last_run_id: params.runId,
                status: "imported",
                imported_at: params.now,
                removed_source: 0,
              }),
            ),
        );
      }
    },
    { env: { ...params.env, OPENCLAW_STATE_DIR: params.stateDir } },
    { operationLabel: "meeting-transcripts.legacy-import" },
  );
}
