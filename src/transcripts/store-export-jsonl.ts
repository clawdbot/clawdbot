import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { writeExternalFileWithinRoot } from "../infra/fs-safe.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import {
  meetingTranscriptSessionQuery,
  meetingTranscriptUtteranceQuery,
  utteranceFromRow,
} from "./store-sqlite.js";

const TRANSCRIPT_EXPORT_ROW_BATCH_SIZE = 64;

export function transcriptJsonlDigest(
  database: DatabaseSync,
  session: TranscriptSessionDescriptor,
): string {
  const query = meetingTranscriptUtteranceQuery(database, session)
    .selectAll()
    .orderBy("sequence", "asc");
  const digest = createHash("sha256");
  for (const row of iterateSqliteQuerySync(database, query)) {
    digest.update(`${JSON.stringify(utteranceFromRow(row))}\n`);
  }
  return digest.digest("hex");
}

export async function writeTranscriptJsonlArtifact(params: {
  sessionDir: string;
  session: TranscriptSessionDescriptor;
  databaseOptions: OpenClawStateDatabaseOptions;
}): Promise<string> {
  ensureMeetingTranscriptsSchema(params.databaseOptions);
  const database = openOpenClawStateDatabase(params.databaseOptions);
  const sequenceHead = executeSqliteQueryTakeFirstSync(
    database.db,
    meetingTranscriptSessionQuery(database.db, params.session).select("next_utterance_seq"),
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
            meetingTranscriptUtteranceQuery(database.db, params.session)
              .selectAll()
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
