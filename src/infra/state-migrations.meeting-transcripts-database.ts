import type { DatabaseSync } from "node:sqlite";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { getNodeSqliteKysely } from "./kysely-sync.js";

type MeetingTranscriptMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "meeting_transcript_sessions"
  | "meeting_transcript_summaries"
  | "meeting_transcript_utterances"
  | "migration_runs"
  | "migration_sources"
>;

export function migrationDb(db: DatabaseSync) {
  return getNodeSqliteKysely<MeetingTranscriptMigrationDatabase>(db);
}
