import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { ensureOpenClawAgentSessionSharingSchemaInTransaction } from "../../state/openclaw-agent-session-sharing-schema.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";

type SessionMemberDatabase = Pick<OpenClawAgentKyselyDatabase, "session_members">;

type SessionMember = {
  identityId: string;
  addedBy: string;
  addedAt: number;
};

const ensuredDatabases = new WeakSet<DatabaseSync>();
const SESSION_MEMBERSHIP_QUERY_CHUNK_SIZE = 400;

function resolveDatabaseOptions(scope: SessionAccessScope): OpenClawAgentDatabaseOptions {
  return toDatabaseOptions(resolveSqliteScope(scope));
}

function ensureSessionSharingSchema(options: OpenClawAgentDatabaseOptions): OpenClawAgentDatabase {
  const database = openOpenClawAgentDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return database;
  }
  runOpenClawAgentWriteTransaction((transactionDatabase) => {
    ensureOpenClawAgentSessionSharingSchemaInTransaction(transactionDatabase.db);
  }, options);
  ensuredDatabases.add(database.db);
  return database;
}

function getSessionMemberKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<SessionMemberDatabase>(database.db);
}

export function listSessionMembers(scope: SessionAccessScope): SessionMember[] {
  const database = ensureSessionSharingSchema(resolveDatabaseOptions(scope));
  const db = getSessionMemberKysely(database);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_members")
      .select(["identity_id", "added_by", "added_at"])
      .where("session_key", "=", resolveSqliteScope(scope).sessionKey)
      .orderBy("identity_id"),
  ).rows.map((row) => ({
    identityId: row.identity_id,
    addedBy: row.added_by,
    addedAt: row.added_at,
  }));
}

export function listSessionMembershipKeys(
  scope: SessionAccessScope,
  sessionKeys: readonly string[],
  identityId: string,
): Set<string> {
  const normalizedIdentityId = identityId.trim();
  const normalizedSessionKeys = [...new Set(sessionKeys.map((key) => key.trim()).filter(Boolean))];
  if (!normalizedIdentityId || normalizedSessionKeys.length === 0) {
    return new Set();
  }
  const database = ensureSessionSharingSchema(resolveDatabaseOptions(scope));
  const db = getSessionMemberKysely(database);
  const memberships = new Set<string>();
  for (
    let offset = 0;
    offset < normalizedSessionKeys.length;
    offset += SESSION_MEMBERSHIP_QUERY_CHUNK_SIZE
  ) {
    const chunk = normalizedSessionKeys.slice(offset, offset + SESSION_MEMBERSHIP_QUERY_CHUNK_SIZE);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_members")
        .select("session_key")
        .where("identity_id", "=", normalizedIdentityId)
        .where("session_key", "in", chunk),
    ).rows;
    for (const row of rows) {
      memberships.add(row.session_key);
    }
  }
  return memberships;
}

export function isSessionMember(scope: SessionAccessScope, identityId: string): boolean {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return false;
  }
  const database = ensureSessionSharingSchema(resolveDatabaseOptions(scope));
  const db = getSessionMemberKysely(database);
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_members")
        .select("identity_id")
        .where("session_key", "=", resolveSqliteScope(scope).sessionKey)
        .where("identity_id", "=", normalizedIdentityId),
    ),
  );
}

// Membership is bound to a live session entry, never a transcript placeholder.
// Authorization is rechecked before these transactions, but a reset/recreate
// can replace the row under the same key in between; the optional expected id
// adds a caller snapshot check after the canonical node/entry check.
function assertAuthorizedSessionInstance(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  expectedSessionId: string | undefined,
): void {
  const row =
    database.db /* sqlite-allow-raw: sync TOCTOU re-read of canonical entry identity inside a write transaction; Kysely async execution is forbidden in synchronous commit sections */
      .prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { current_session_id?: string; entry_json?: string } | undefined;
  let entrySessionId: string | undefined;
  try {
    const entry = row?.entry_json ? (JSON.parse(row.entry_json) as unknown) : undefined;
    const candidate =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { sessionId?: unknown }).sessionId
        : undefined;
    entrySessionId = typeof candidate === "string" ? candidate : undefined;
  } catch {
    entrySessionId = undefined;
  }
  if (
    !row ||
    entrySessionId === undefined ||
    row.current_session_id !== entrySessionId ||
    (expectedSessionId !== undefined && entrySessionId !== expectedSessionId)
  ) {
    throw new Error("session changed before sharing mutation");
  }
}

export function addSessionMember(
  scope: SessionAccessScope,
  params: { identityId: string; addedBy: string; addedAt?: number; expectedSessionId?: string },
): { member: SessionMember; inserted: boolean } {
  const identityId = params.identityId.trim();
  const addedBy = params.addedBy.trim();
  if (!identityId || !addedBy) {
    throw new Error("session member identity and actor are required");
  }
  const options = resolveDatabaseOptions(scope);
  ensureSessionSharingSchema(options);
  const addedAt = params.addedAt ?? Date.now();
  const inserted = runOpenClawAgentWriteTransaction((database) => {
    assertAuthorizedSessionInstance(
      database,
      resolveSqliteScope(scope).sessionKey,
      params.expectedSessionId,
    );
    const db = getSessionMemberKysely(database);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .insertInto("session_members")
        .values({
          session_key: resolveSqliteScope(scope).sessionKey,
          identity_id: identityId,
          added_by: addedBy,
          added_at: addedAt,
        })
        .onConflict((conflict) => conflict.columns(["session_key", "identity_id"]).doNothing()),
    );
    return (result.numAffectedRows ?? 0n) > 0n;
  }, options);
  return { member: { identityId, addedBy, addedAt }, inserted };
}

export function removeSessionMember(
  scope: SessionAccessScope,
  identityId: string,
  expected?: Pick<SessionMember, "addedBy" | "addedAt">,
  expectedSessionId?: string,
): SessionMember | null {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return null;
  }
  const options = resolveDatabaseOptions(scope);
  ensureSessionSharingSchema(options);
  return runOpenClawAgentWriteTransaction((database) => {
    assertAuthorizedSessionInstance(
      database,
      resolveSqliteScope(scope).sessionKey,
      expectedSessionId,
    );
    const db = getSessionMemberKysely(database);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_members")
        .select(["identity_id", "added_by", "added_at"])
        .where("session_key", "=", resolveSqliteScope(scope).sessionKey)
        .where("identity_id", "=", normalizedIdentityId),
    );
    if (
      !row ||
      (expected && (row.added_by !== expected.addedBy || row.added_at !== expected.addedAt))
    ) {
      return null;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("session_members")
        .where("session_key", "=", resolveSqliteScope(scope).sessionKey)
        .where("identity_id", "=", normalizedIdentityId),
    );
    return { identityId: row.identity_id, addedBy: row.added_by, addedAt: row.added_at };
  }, options);
}
