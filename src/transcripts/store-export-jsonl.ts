import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import { meetingTranscriptDb, utteranceFromRow } from "./store-sqlite.js";

const TRANSCRIPT_EXPORT_ROW_BATCH_SIZE = 64;

export async function writeTranscriptJsonlArtifact(params: {
  sessionDir: string;
  session: TranscriptSessionDescriptor;
  databaseOptions: OpenClawStateDatabaseOptions;
}): Promise<string> {
  ensureMeetingTranscriptsSchema(params.databaseOptions);
  const database = openOpenClawStateDatabase(params.databaseOptions);
  const sequenceHead = executeSqliteQueryTakeFirstSync(
    database.db,
    meetingTranscriptDb(database.db)
      .selectFrom("meeting_transcript_sessions")
      .select("next_utterance_seq")
      .where("session_id", "=", params.session.sessionId)
      .where("started_at", "=", params.session.startedAt),
  )?.next_utterance_seq;
  if (sequenceHead === undefined) {
    throw new Error(`transcripts session not found: ${params.session.sessionId}`);
  }
  const digest = createHash("sha256");
  await writeExternalFileWithinRoot({
    rootDir: params.sessionDir,
    path: "transcript.jsonl",
    write: async (tempPath) => {
      const handle = await fs.open(tempPath, "w", 0o600);
      try {
        let nextSequence = 0;
        while (nextSequence < sequenceHead) {
          const rows = executeSqliteQuerySync(
            database.db,
            meetingTranscriptDb(database.db)
              .selectFrom("meeting_transcript_utterances")
              .selectAll()
              .where("session_id", "=", params.session.sessionId)
              .where("session_started_at", "=", params.session.startedAt)
              .where("sequence", ">=", nextSequence)
              .where("sequence", "<", sequenceHead)
              .orderBy("sequence", "asc")
              .limit(TRANSCRIPT_EXPORT_ROW_BATCH_SIZE),
          ).rows;
          if (rows.length === 0) {
            break;
          }
          nextSequence = rows.at(-1)!.sequence + 1;
          const lines = rows.map((row) => `${JSON.stringify(utteranceFromRow(row))}\n`);
          for (const line of lines) {
            await handle.writeFile(line);
            digest.update(line);
          }
        }
      } finally {
        await handle.close();
      }
    },
  });
  return digest.digest("hex");
}
