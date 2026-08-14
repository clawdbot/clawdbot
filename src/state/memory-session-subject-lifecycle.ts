import type { SessionEntry } from "../config/sessions/types.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { ensureMemoryOperationalPrincipal } from "./memory-identity.js";
import {
  deferOpenClawAgentPostCommitPublication,
  getOpenClawAgentDatabaseStateOptions,
  type OpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { AGENT_SESSION_MEMORY_SCHEMA_SQL } from "./openclaw-agent-session-memory-schema.js";

export type MemorySessionSubjectSnapshot = Readonly<{
  sessionKey: string;
  sessionId: string;
  subjectRevision: string;
  sessionIdentityRevision: string;
}>;

type SnapshotRow = {
  session_key: string;
  session_id: string;
  subject_revision: string;
  session_identity_revision: string;
};

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function toSnapshot(row: SnapshotRow): MemorySessionSubjectSnapshot {
  return Object.freeze({
    sessionKey: row.session_key,
    sessionId: row.session_id,
    subjectRevision: row.subject_revision,
    sessionIdentityRevision: row.session_identity_revision,
  });
}

/**
 * The canonical session writer assigns ambiguity for sources that cannot carry
 * a post-transport identity proof. Channel creation defers to its exact
 * inbound context, which may still establish a bound direct-message subject.
 */
export function ensureMemorySessionSubjectForSessionEntryInTransaction(params: {
  database: OpenClawAgentDatabase;
  sessionKey: string;
  sessionId: string;
  deferToInboundChannelAdmission: boolean;
  entry: Pick<SessionEntry, "createdActor" | "createdVia" | "spawnedBy">;
  quarantineImport?: boolean;
}): MemorySessionSubjectSnapshot | undefined {
  const sessionKey = requireText(params.sessionKey, "sessionKey");
  const sessionId = requireText(params.sessionId, "sessionId");
  const database = params.database;
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Feature-local additive lazy ensure.
  const mapping = database.db
    .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
    .get(sessionKey) as { current_session_id?: string } | undefined;
  if (!mapping || mapping.current_session_id !== sessionId) {
    throw new Error("session-rebound");
  }
  const subject = database.db
    .prepare("SELECT subject_revision FROM session_memory_subjects WHERE session_key = ?")
    .get(sessionKey) as { subject_revision: string } | undefined;
  // Only a first channel creation waits for its exact inbound proof. Later
  // reset/fork/rollover writes must copy the already immutable subject.
  if (!subject && params.deferToInboundChannelAdmission) {
    return undefined;
  }
  if (!subject) {
    const initial = resolveInitialMemorySubject({
      database,
      entry: params.entry,
      sessionKey,
      quarantineImport: params.quarantineImport === true,
    });
    database.db
      .prepare(
        `INSERT INTO session_memory_subjects
         (session_key, binding_id, principal_id, subject_kind, subject_revision, created_at)
         VALUES (?, NULL, ?, ?, ?, ?)`,
      )
      .run(sessionKey, initial.principalId, initial.kind, generateSecureUuid(), Date.now());
  }
  return snapshotMemorySessionSubjectInTransaction({ database, sessionKey, sessionId });
}

/**
 * Session lifecycle owners call this after writing the current node mapping,
 * inside that same SQLite commit. It can only copy the existing immutable
 * subject; a reset, fork, recovery, or import can never select a new one.
 */
export function snapshotMemorySessionSubjectInTransaction(params: {
  database: OpenClawAgentDatabase;
  sessionKey: string;
  sessionId: string;
}): MemorySessionSubjectSnapshot | undefined {
  const sessionKey = requireText(params.sessionKey, "sessionKey");
  const sessionId = requireText(params.sessionId, "sessionId");
  const database = params.database;
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Feature-local additive lazy ensure.
  const mapping = database.db
    .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
    .get(sessionKey) as { current_session_id?: string } | undefined;
  if (!mapping || mapping.current_session_id !== sessionId) {
    throw new Error("session-rebound");
  }
  const subject = database.db
    .prepare("SELECT subject_revision FROM session_memory_subjects WHERE session_key = ?")
    .get(sessionKey) as { subject_revision: string } | undefined;
  if (!subject) {
    return undefined;
  }
  const existing = database.db
    .prepare(
      "SELECT session_key, session_id, subject_revision, session_identity_revision FROM session_memory_subject_snapshots WHERE session_id = ?",
    )
    .get(sessionId) as SnapshotRow | undefined;
  if (existing) {
    if (
      existing.session_key !== sessionKey ||
      existing.subject_revision !== subject.subject_revision
    ) {
      throw new Error("memory session snapshot conflicts with immutable provenance");
    }
    return toSnapshot(existing);
  }
  const snapshot = {
    session_key: sessionKey,
    session_id: sessionId,
    subject_revision: subject.subject_revision,
    session_identity_revision: generateSecureUuid(),
  };
  database.db
    .prepare(
      `INSERT INTO session_memory_subject_snapshots
       (session_id, session_key, subject_revision, session_identity_revision, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      snapshot.session_id,
      snapshot.session_key,
      snapshot.subject_revision,
      snapshot.session_identity_revision,
      Date.now(),
    );
  return toSnapshot(snapshot);
}

function resolveInitialMemorySubject(params: {
  database: OpenClawAgentDatabase;
  entry: Pick<SessionEntry, "createdActor" | "createdVia" | "spawnedBy">;
  sessionKey: string;
  quarantineImport: boolean;
}): {
  kind: "ambiguous" | "quarantined" | "service" | "agent" | "system";
  principalId: string | null;
} {
  if (params.quarantineImport) {
    return { kind: "quarantined", principalId: null };
  }
  const actor = params.entry.createdActor;
  const kind =
    actor?.type === "system" || params.entry.createdVia === "internal"
      ? "system"
      : actor?.type === "agent" || params.entry.createdVia === "spawn"
        ? "agent"
        : params.entry.createdVia === "cron" ||
            params.entry.createdVia === "talk" ||
            params.entry.createdVia === "run" ||
            params.entry.createdVia === "plugin"
          ? "service"
          : undefined;
  if (!kind) {
    return { kind: "ambiguous", principalId: null };
  }
  const stableRef = [params.database.agentId, kind, params.sessionKey].join("\u0000");
  const principalId = generateSecureUuid();
  // Shared-state principal registration is after the transcript transaction.
  // If the process exits first, later context creation fails closed instead of
  // treating an unregistered local subject as usable authority.
  deferOpenClawAgentPostCommitPublication(params.database, () => {
    ensureMemoryOperationalPrincipal({
      kind,
      stableRef,
      principalId,
      options: getOpenClawAgentDatabaseStateOptions(params.database),
    });
  });
  return { kind, principalId };
}
