/** Private-local SDK subpath for memory session transcript helpers. */
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentDatabase } from "../state/openclaw-agent-db.generated.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";

export {
  buildSessionEntry,
  extractKeywords,
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
  isQueryStopWordToken,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  listSessionFilesForAgent,
  listSessionTranscriptCorpusEntriesForAgent,
  loadDreamingNarrativeTranscriptPathSetForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  parseCanonicalSessionSyncTargetFromPath,
  parseSqliteSessionFileMarker,
  parseUsageCountedSessionIdFromFileName,
  resolveSessionFileForSyncTarget,
  resolveSessionIdentityForTranscriptFile,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntrySync,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";
export type {
  BuildSessionEntryOptions,
  ResolvedMemorySessionSyncTarget,
  ResolvedSessionTranscriptIdentity,
  SessionFileEntry,
  SessionFileState,
  SessionTranscriptClassification,
  SessionTranscriptCorpusEntry,
  SessionTranscriptCorpusOptions,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";

export type MemorySessionTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  hookExternalContentSource: string | null;
  channel: string | null;
  accountId: string | null;
  chatType: string | null;
  createdAt: number;
  participantIds: string[];
};

export type MemorySessionSelectors = {
  agentId: string;
  sessionIds?: readonly string[];
  hookSources?: readonly string[];
  participants?: readonly string[];
  since?: string | number;
};

type SessionMetadataDatabase = Pick<
  OpenClawAgentDatabase,
  "session_windows" | "session_participants" | "session_transcript_archives"
>;

const SESSION_METADATA_COLUMNS = [
  "session_windows.session_id",
  "session_windows.session_key",
  "session_windows.hook_external_content_source",
  "session_windows.channel",
  "session_windows.account_id",
  "session_windows.chat_type",
  "session_windows.created_at",
] as const;

function projectSessionMetadata(
  agentId: string,
  row: {
    session_id: string;
    session_key: string;
    hook_external_content_source: string | null;
    channel: string | null;
    account_id: string | null;
    chat_type: string | null;
    created_at: number;
  },
  participantIds: string[] = [],
): MemorySessionTarget {
  return {
    agentId,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    hookExternalContentSource: row.hook_external_content_source,
    channel: row.channel,
    accountId: row.account_id,
    chatType: row.chat_type,
    createdAt: row.created_at,
    participantIds,
  };
}

/** Read authoritative admission facts without creating a missing agent database. */
export function loadMemorySessionMetadata(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
}): MemorySessionTarget | undefined {
  const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    let query = getNodeSqliteKysely<SessionMetadataDatabase>(db)
      .selectFrom("session_windows")
      .select(SESSION_METADATA_COLUMNS)
      .where("session_id", "=", params.sessionId);
    if (params.sessionKey) {
      query = query.where("session_key", "=", params.sessionKey);
    }
    const row = executeSqliteQuerySync(db, query).rows[0];
    return row ? projectSessionMetadata(params.agentId, row) : undefined;
  }, params);
  return result.found ? result.value : undefined;
}

/** Resolve retained archive identities after their live session rows disappear. */
export function loadArchivedSessions(params: {
  agentId: string;
  sessionIds: readonly string[];
}): Array<{ archiveName: string; sessionId: string; sessionKey: string }> {
  const sessionIds = [...new Set(params.sessionIds)];
  if (sessionIds.length === 0) {
    return [];
  }
  const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    if (!tableExists(db, "session_transcript_archives")) {
      return [];
    }
    return executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<SessionMetadataDatabase>(db)
        .selectFrom("session_transcript_archives")
        .select(["archive_name", "session_id", "session_key"])
        .where("session_id", "in", sessionIds),
    ).rows.map((archive) => ({
      archiveName: archive.archive_name,
      sessionId: archive.session_id,
      sessionKey: archive.session_key,
    }));
  }, params);
  return result.found ? result.value : [];
}

/** Resolve explicit memory-forget selectors against authoritative session owners. */
export function resolveMemorySessionTargets(params: MemorySessionSelectors): MemorySessionTarget[] {
  const sessionIds = [...new Set(params.sessionIds ?? [])];
  const hookSources = [...new Set(params.hookSources ?? [])];
  const participants = [...new Set(params.participants ?? [])];
  if (sessionIds.length === 0 && hookSources.length === 0 && participants.length === 0) {
    return [];
  }
  const since = typeof params.since === "string" ? Date.parse(params.since) : params.since;
  if (since !== undefined && !Number.isFinite(since)) {
    throw new Error(`Invalid memory session date: ${params.since}`);
  }
  const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    const sessionDb = getNodeSqliteKysely<SessionMetadataDatabase>(db);
    const hasParticipants = tableExists(db, "session_participants");
    if (!hasParticipants && sessionIds.length === 0 && hookSources.length === 0) {
      return [];
    }
    let query = sessionDb
      .selectFrom("session_windows")
      .select(SESSION_METADATA_COLUMNS)
      .where((expression) =>
        expression.or([
          ...(sessionIds.length > 0
            ? [
                expression("session_windows.session_id", "in", sessionIds),
                expression("session_windows.session_key", "in", sessionIds),
              ]
            : []),
          ...(hookSources.length > 0
            ? [expression("session_windows.hook_external_content_source", "in", hookSources)]
            : []),
          ...(participants.length > 0 && hasParticipants
            ? [
                expression.exists(
                  expression
                    .selectFrom("session_participants")
                    .select("session_key")
                    .whereRef(
                      "session_participants.session_key",
                      "=",
                      "session_windows.session_key",
                    )
                    .where("actor_id", "in", participants),
                ),
              ]
            : []),
        ]),
      );
    if (since !== undefined) {
      query = query.where("session_windows.created_at", ">=", since);
    }
    const rows = executeSqliteQuerySync(
      db,
      query.orderBy("session_windows.created_at").orderBy("session_windows.session_id"),
    ).rows;
    const participantIds = new Map<string, string[]>();
    if (rows.length > 0 && hasParticipants) {
      const keys = [...new Set(rows.map((row) => row.session_key))];
      const participantRows = executeSqliteQuerySync(
        db,
        sessionDb
          .selectFrom("session_participants")
          .select(["session_key", "actor_id"])
          .where("session_key", "in", keys)
          .orderBy("session_key")
          .orderBy("actor_id"),
      ).rows;
      for (const participant of participantRows) {
        const ids = participantIds.get(participant.session_key) ?? [];
        if (!ids.includes(participant.actor_id)) {
          ids.push(participant.actor_id);
        }
        participantIds.set(participant.session_key, ids);
      }
    }
    return rows.map((row) =>
      projectSessionMetadata(params.agentId, row, participantIds.get(row.session_key)),
    );
  }, params);
  return result.found ? result.value : [];
}
