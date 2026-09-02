import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { SESSION_PARTICIPANTS_TABLE } from "../../state/openclaw-agent-session-participants-schema.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readParticipantIdentity,
  type SessionParticipantIdentity,
} from "./session-participant-identity.js";
import type { SessionEntry } from "./types.js";

export type SessionParticipantRecord = {
  identity: SessionParticipantIdentity;
  contributionCount: number;
  firstPromptedAt: number | null;
  lastPromptedAt: number | null;
};

function participantRecordsBySessionKey(
  database: DatabaseSync,
  sessionKeys?: readonly string[],
): Map<string, SessionParticipantRecord[]> {
  const records = new Map<string, SessionParticipantRecord[]>();
  if (!tableExists(database, SESSION_PARTICIPANTS_TABLE) || sessionKeys?.length === 0) {
    return records;
  }
  let query = getSessionKysely(database).selectFrom("session_participants").selectAll();
  if (sessionKeys) {
    query = query.where("session_key", "in", sessionKeys);
  }
  for (const row of executeSqliteQuerySync(
    database,
    query
      .orderBy("session_key")
      .orderBy("first_prompted_at")
      .orderBy("actor_id")
      .orderBy("identity_namespace"),
  ).rows) {
    const participants = records.get(row.session_key) ?? [];
    participants.push({
      identity: readParticipantIdentity(row.identity_namespace, row.actor_id),
      contributionCount: row.contribution_count,
      firstPromptedAt: row.first_prompted_at,
      lastPromptedAt: row.last_prompted_at,
    });
    records.set(row.session_key, participants);
  }
  return records;
}

function withProjectedParticipants(
  entry: SessionEntry,
  records: readonly SessionParticipantRecord[],
): SessionEntry {
  if (records.length === 0) {
    return entry;
  }
  return {
    ...entry,
    participants: records.map(({ identity }) => ({ identity })),
    participantCount: records.length,
  };
}

export function projectSqliteSessionParticipants(
  database: DatabaseSync,
  sessionKey: string,
  entry: SessionEntry,
): SessionEntry {
  return withProjectedParticipants(
    entry,
    participantRecordsBySessionKey(database, [sessionKey]).get(sessionKey) ?? [],
  );
}

export function projectSqliteSessionParticipantsBatch(
  database: DatabaseSync,
  entries: ReadonlyMap<string, SessionEntry>,
): Map<string, SessionEntry> {
  const records = participantRecordsBySessionKey(database, [...entries.keys()]);
  return new Map(
    [...entries].map(([sessionKey, entry]) => [
      sessionKey,
      withProjectedParticipants(entry, records.get(sessionKey) ?? []),
    ]),
  );
}

export function listSessionParticipantsReadOnly(scope: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
}): Map<string, SessionParticipantRecord[]> {
  const resolved = resolveSqliteReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      participantRecordsBySessionKey(
        database.db,
        scope.sessionKey ? [scope.sessionKey] : undefined,
      ),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : new Map();
}
