import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { SESSION_PARTICIPANTS_TABLE } from "../../state/openclaw-agent-session-participants-schema.js";
import { tableExists, tableHasColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  MAX_SESSION_PARTICIPANTS,
  type SessionCreatedActor,
  type SessionParticipantSource,
} from "./session-entry-provenance.js";
import type { SessionEntry } from "./types.js";

export type SessionParticipantRecord = {
  actor: SessionCreatedActor & { id: string };
  firstPromptedAt: number;
  lastPromptedAt: number;
  source?: SessionParticipantSource;
};

export function resolveBoundedProfileParticipantSnapshot(
  records: readonly SessionParticipantRecord[],
  currentProfileId?: string,
): { profileIds: string[]; incomplete: boolean } {
  const profileIds = new Set(
    records.flatMap((record) =>
      record.actor.type === "human" && record.source === "profile" ? [record.actor.id] : [],
    ),
  );
  const current = currentProfileId?.trim();
  if (current && !profileIds.has(current) && records.length < MAX_SESSION_PARTICIPANTS) {
    profileIds.add(current);
  }
  return {
    profileIds: [...profileIds],
    incomplete: records.length >= MAX_SESSION_PARTICIPANTS,
  };
}

function projectParticipantRow(row: {
  actor_id: string;
  actor_source?: string | null;
  actor_type: string;
  first_prompted_at: number;
  last_prompted_at: number;
}): SessionParticipantRecord | null {
  if (row.actor_type !== "agent" && row.actor_type !== "human") {
    return null;
  }
  return {
    actor: { type: row.actor_type, id: row.actor_id },
    firstPromptedAt: row.first_prompted_at,
    lastPromptedAt: row.last_prompted_at,
    ...(row.actor_source === "profile" ||
    row.actor_source === "channel" ||
    row.actor_source === "agent"
      ? { source: row.actor_source }
      : {}),
  };
}

function readParticipantRows(database: DatabaseSync, sessionKeys?: readonly string[]) {
  if (!tableExists(database, SESSION_PARTICIPANTS_TABLE) || sessionKeys?.length === 0) {
    return [];
  }
  // Lazy-ensured column: pre-feature databases lack actor_source, so select it
  // only when present; projection treats the absent field as unknown/legacy.
  const hasActorSource = tableHasColumn(database, SESSION_PARTICIPANTS_TABLE, "actor_source");
  let query = getSessionKysely(database)
    .selectFrom("session_participants")
    .select([
      "session_key",
      "actor_type",
      "actor_id",
      ...(hasActorSource ? (["actor_source"] as const) : []),
      "first_prompted_at",
      "last_prompted_at",
    ]);
  if (sessionKeys) {
    query = query.where("session_key", "in", sessionKeys);
  }
  return executeSqliteQuerySync(
    database,
    query
      .orderBy("session_key")
      .orderBy("first_prompted_at")
      .orderBy("actor_id")
      .orderBy("actor_type"),
  ).rows;
}

function participantRecordsBySessionKey(
  database: DatabaseSync,
  sessionKeys?: readonly string[],
): Map<string, SessionParticipantRecord[]> {
  const records = new Map<string, SessionParticipantRecord[]>();
  for (const row of readParticipantRows(database, sessionKeys)) {
    const projected = projectParticipantRow(row);
    if (!projected) {
      continue;
    }
    const participants = records.get(row.session_key) ?? [];
    participants.push(projected);
    records.set(row.session_key, participants);
  }
  return records;
}

function withProjectedParticipants(
  entry: SessionEntry,
  records: readonly SessionParticipantRecord[],
): SessionEntry {
  const owner = entry.owner?.actor ?? entry.createdActor;
  const effective = records.filter(
    (participant) => participant.actor.type !== owner?.type || participant.actor.id !== owner.id,
  );
  if (effective.length === 0) {
    return entry;
  }
  return {
    ...entry,
    participants: effective.map((participant) => ({
      ...participant.actor,
      ...(participant.source ? { source: participant.source } : {}),
    })),
    participantCount: effective.length,
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
