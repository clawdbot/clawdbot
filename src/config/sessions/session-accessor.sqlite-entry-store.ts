import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import {
  linkSessionConversation,
  prepareSessionConversationForWrite,
  upsertConversationIdentity,
} from "./session-accessor.sqlite-conversation.js";
import { commitSqliteSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import {
  publishSessionEntryCacheInvalidation,
  trackSessionEntryCacheWrite,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  sqliteSessionEntriesEqual,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  clearSessionCollaborationForKey,
  copySessionNodeArtifactsForRepair,
  deleteSessionDeliveryArtifacts,
  deleteSessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import {
  hasSqliteSessionOwnerColumns,
  type SqliteSessionOwnerRow,
} from "./session-accessor.sqlite-owner-projection.js";
import { projectSqliteSessionParticipants } from "./session-accessor.sqlite-participant-projection.js";
import { resolveSessionEntryProvenanceRow } from "./session-accessor.sqlite-provenance.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely, normalizeSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import {
  bindSessionNode,
  bindSessionRoot,
  normalizeSessionEntryTimestamp,
} from "./session-accessor.sqlite-session-row.js";
import {
  hasValidSessionEntryIdentity,
  parseSessionEntryJson as parseSessionEntryRow,
  sessionEntryMetadataJson,
  selectSessionEntryRows,
} from "./session-accessor.sqlite-status.js";
import { readTranscriptMutationStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  assertCanonicalSessionEntryLineageWrite,
  assertCanonicalSqliteSessionKeysCurrent,
  assertCanonicalSessionKeyWriteMatchesDatabase,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import { preserveCreationStamp } from "./session-entry-provenance.js";
import {
  collectSessionEntryLookupKeys,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
export { collectSessionEntryLookupKeys } from "./store-entry.js";
export {
  iterateSessionEntryKeys,
  readSessionEntryCount,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-inventory.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_nodes"]>;
export type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  row: Pick<SessionEntryRow, "current_session_id" | "entry_json" | "session_key" | "updated_at"> &
    SqliteSessionOwnerRow;
};

/** Decodes a fresh owned entry, including its nested JSON, owner and participant values. */
export function parseReadableSqliteSessionEntryRow(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: ResolvedSessionEntryRow["row"],
  projection: "full" | "list" = "full",
): SessionEntry | null {
  const parsed = parseSessionEntryRow(row, projection);
  if (parsed) {
    const entry = projectSqliteSessionParticipants(database.db, row.session_key, parsed);
    if (resolveDeliveryProvenCanonicalSessionKey(row.session_key, entry) !== row.session_key) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${row.session_key}`,
      );
    }
    return entry;
  }
  const retainedWindow =
    row.entry_json === "{}"
      ? executeSqliteQueryTakeFirstSync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_windows")
            .select("session_id")
            .where("session_id", "=", row.current_session_id)
            .where("session_key", "=", row.session_key),
        )
      : undefined;
  if (retainedWindow) {
    return null;
  }
  throw canonicalSessionKeyMigrationRequiredError(
    `invalid persisted session row requires repair for ${row.session_key}`,
  );
}

/** Exact reads already own nested values; retain them through identity publication. */
export function readSessionIdentitySnapshot(
  database: OpenClawAgentDatabase,
  sessionKeys: Iterable<string>,
): Map<string, SessionEntry> {
  const snapshot = new Map<string, SessionEntry>();
  for (const sessionKey of uniqueStrings([...sessionKeys].map((key) => key.trim()))) {
    const row = readExactSessionEntryRow(database, sessionKey);
    if (row) {
      snapshot.set(sessionKey, row.entry);
    }
  }
  return snapshot;
}

export function readSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  assertCanonicalSqliteSessionKeysCurrent(database);
  return readSessionEntryRowUnchecked(database, sessionKey);
}

function readSessionEntryRowUnchecked(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const lookupKeys = collectSessionEntryLookupKeys(database, sessionKey);
  if (lookupKeys.length === 0) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .selectAll()
      .where("session_key", "in", lookupKeys)
      .orderBy("session_key", "asc"),
  ).rows;
  let selected: ResolvedSessionEntryRow | undefined;
  for (const row of rows) {
    const entry = parseReadableSqliteSessionEntryRow(database, row);
    if (!entry || row.session_key !== sessionKey.trim()) {
      continue;
    }
    selected = { entry, row };
  }
  return selected;
}

// Runtime patches own only the exact canonical row. Folded lookup candidates
// can be distinct case-sensitive rooms and must not join its mutation snapshot.
export function readSessionEntrySelectionSnapshot(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  exact: boolean,
): SqliteLifecycleTargetSnapshot {
  const selected = exact
    ? readExactSessionEntryRow(database, sessionKey)
    : readSessionEntryRow(database, sessionKey);
  return selected ? [{ entry: selected.entry, sessionKey: selected.row.session_key }] : [];
}

export function readExactSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: "full" | "list" = "full",
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const query =
    projection === "list"
      ? selectSessionEntryRows(database, projection).select(["current_session_id", "updated_at"])
      : db.selectFrom("session_nodes").selectAll();
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    query.where("session_key", "=", sessionKey),
  );
  if (!row) {
    return undefined;
  }
  const entry = parseReadableSqliteSessionEntryRow(database, row, projection);
  return entry ? { entry, row } : undefined;
}

export function readExactSessionEntryJson(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
): string | undefined {
  const db = getSessionKysely(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_nodes").select("entry_json").where("session_key", "=", sessionKey),
  )?.entry_json;
}

export function readExactSessionEntryRowValidated(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
  projection: "full" | "list" = "full",
): ResolvedSessionEntryRow | undefined {
  assertCanonicalSqliteSessionKeysCurrent(database);
  return readExactSessionEntryRow(database, sessionKey, projection);
}

export function resolveLifecyclePrimaryEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  options: { allowCanonicalMove?: boolean } = {},
): SqliteLifecycleTargetSnapshot[number] | undefined {
  const rows = target.storeKeys.flatMap((key) => {
    const sessionKey = key.trim();
    const row = readExactSessionEntryRow(database, sessionKey);
    return row ? [{ sessionKey, entry: row.entry }] : [];
  });
  if (rows.length > 1) {
    throw canonicalSessionKeyMigrationRequiredError(
      `duplicate rows resolve to canonical session key ${target.canonicalKey}`,
    );
  }
  const [row] = rows;
  if (row && row.sessionKey !== target.canonicalKey && options.allowCanonicalMove !== true) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${target.canonicalKey}`,
    );
  }
  return row;
}

export function readLifecycleTargetSnapshot(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  options: { allowCanonicalMove?: boolean } = {},
): SqliteLifecycleTargetSnapshot {
  assertCanonicalSqliteSessionKeysCurrent(database);
  const normalized = normalizeLifecycleTarget(target);
  const row = resolveLifecyclePrimaryEntry(database, normalized, options);
  return row ? [row] : [];
}

export function normalizeLifecycleTarget(target: { canonicalKey: string; storeKeys: string[] }): {
  canonicalKey: string;
  storeKeys: string[];
} {
  const canonicalKey = normalizeSqliteSessionKey(target.canonicalKey);
  return {
    canonicalKey,
    storeKeys: uniqueStrings([canonicalKey, ...target.storeKeys.map(normalizeSqliteSessionKey)]),
  };
}

export function deleteSessionEntryRows(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  options: {
    deleteOwnedWindows?: boolean;
    deliveryCleanupKeys?: readonly string[];
    validatedEntry?: SessionEntry;
  } = {},
): void {
  // Doctor supplies the exact row it validated; the runtime parser deliberately rejects that shape.
  const previousEntry =
    options.validatedEntry ?? readExactSessionEntryRow(database, sessionKey)?.entry;
  if (previousEntry) {
    commitSqliteSessionDeletion(sessionKey, previousEntry);
  }
  const db = getSessionKysely(database.db);
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "=", sessionKey),
  ).rows;
  // Skip the survivor scan when maintenance reclaimed every window. Otherwise, project
  // reference metadata before acquiring rows to avoid loading unrelated saved prompts.
  const survivingNodes =
    windows.length > 0
      ? executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select(["current_session_id", sessionEntryMetadataJson, "session_key"])
            .where("session_key", "!=", sessionKey)
            .orderBy("session_key", "asc"),
        ).rows
      : [];
  for (const window of windows) {
    const survivingNode = survivingNodes.find((node) => {
      if (node.current_session_id === window.session_id) {
        return true;
      }
      const entry = parseSessionEntryRow(node);
      return entry ? collectSessionStateIdsForEntry(entry).includes(window.session_id) : false;
    });
    if (survivingNode) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_windows")
          .set({ session_key: survivingNode.session_key })
          .where("session_id", "=", window.session_id),
      );
    }
  }
  if (options.deleteOwnedWindows) {
    deleteSessionDeliveryArtifacts(database, sessionKey, options.deliveryCleanupKeys);
    deleteSessionNodeArtifacts(database, sessionKey);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
    );
    publishSessionEntryCacheInvalidation(database);
    return;
  }
  const remainingWindow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "updated_at"])
      .where("session_key", "=", sessionKey)
      .orderBy("updated_at", "desc")
      .orderBy("session_id", "asc")
      .limit(1),
  );
  if (remainingWindow) {
    deleteSessionNodeArtifacts(database, sessionKey);
    clearSqliteSessionEntryPreservingWindows(database, {
      sessionId: remainingWindow.session_id,
      sessionKey,
      updatedAt: remainingWindow.updated_at,
    });
    publishSessionEntryCacheInvalidation(database);
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
  );
  publishSessionEntryCacheInvalidation(database);
}

/** Remove the logical entry while retaining its node-owned transcript windows. */
function clearSqliteSessionEntryPreservingWindows(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  const cleared = {
    current_session_id: params.sessionId,
    entry_json: "{}",
    entry_valid: -1,
    updated_at: params.updatedAt,
    status: null,
    created_at: null,
    created_via: null,
    created_actor_type: null,
    created_actor_id: null,
    project_id: null,
    parent_session_key: null,
    spawned_by: null,
    fork_source_session_key: null,
    fork_source_session_id: null,
    fork_source_entry_id: null,
    label: null,
    display_name: null,
    category: null,
    icon: null,
    pinned_at: null,
    archived_at: null,
    last_read_at: null,
    last_interaction_at: null,
    last_activity_at: null,
    ...(hasSqliteSessionOwnerColumns(database.db)
      ? {
          owner_actor_type: null,
          owner_actor_id: null,
          owner_assigned_by_type: null,
          owner_assigned_by_id: null,
          owner_assigned_at: null,
        }
      : {}),
  } as const;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values({ session_key: params.sessionKey, ...cleared })
      .onConflict((conflict) => conflict.column("session_key").doUpdateSet(cleared)),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_nodes")
      .set({ entry_valid: -1 })
      .where("session_key", "=", params.sessionKey),
  );
}

export function deleteLifecycleTargetRows(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): void {
  for (const sessionKey of uniqueStrings([target.canonicalKey, ...target.storeKeys])) {
    const trimmed = sessionKey.trim();
    if (trimmed) {
      deleteSessionEntryRows(database, trimmed);
    }
  }
}

function sqliteLifecycleTargetMatchesExpectedEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expectedEntry: SessionEntry | undefined,
): boolean {
  const current = resolveLifecyclePrimaryEntry(database, target)?.entry;
  if (!current || !expectedEntry) {
    return current === expectedEntry;
  }
  return sqliteSessionEntriesEqual(current, expectedEntry);
}

export function assertLifecycleTargetUnchanged(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expectedEntry: SessionEntry | undefined,
  operation: "deleted" | "reset",
): void {
  if (sqliteLifecycleTargetMatchesExpectedEntry(database, target, expectedEntry)) {
    return;
  }
  throw new Error(`SQLite session entry changed before ${operation} lifecycle mutation`);
}

export function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
  options: { rehomeMembers?: boolean; validatedEntries?: ReadonlyMap<string, SessionEntry> } = {},
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    const previousEntry =
      options.validatedEntries?.get(legacyKey) ??
      readExactSessionEntryRow(database, legacyKey)?.entry;
    if (previousEntry) {
      commitSqliteSessionDeletion(legacyKey, previousEntry);
    }
    rehomeSessionWindows(database, sessionKey, [legacyKey]);
    copySessionNodeArtifactsForRepair(database, database, [legacyKey], sessionKey, {
      includeMembers: options.rehomeMembers,
    });
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", legacyKey),
    );
    publishSessionEntryCacheInvalidation(database);
  }
}

/** Move retained generations to the canonical node before removing key aliases. */
export function rehomeSessionWindows(
  database: OpenClawAgentDatabase,
  canonicalKey: string,
  previousKeys: Iterable<string>,
): void {
  const legacyKeys = uniqueStrings([...previousKeys].map((key) => key.trim())).filter(
    (key) => key && key !== canonicalKey,
  );
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_windows")
      .set({ session_key: canonicalKey })
      .where("session_key", "in", legacyKeys),
  );
}

export function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  options: {
    allowStoredAliases?: boolean;
    consumePendingReset?: boolean;
    preserveNodeSuggestions?: boolean;
    previousEntry?: SessionEntry | null;
    routeContext?: ConversationRouteContext | null;
  } = {},
): SessionEntry {
  const db = getSessionKysely(database.db);
  if (!options.allowStoredAliases) {
    assertCanonicalSessionKeyWriteMatchesDatabase(database, sessionKey);
    assertCanonicalSessionEntryLineageWrite(database, entry);
    if (resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry) !== sessionKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `refusing non-canonical session key write ${sessionKey}`,
      );
    }
  }
  let normalizedEntry = normalizeSessionEntryTimestamp(entry);
  if (!hasValidSessionEntryIdentity(normalizedEntry)) {
    throw new Error("Refusing invalid SQLite session entry identity");
  }
  // Doctor validated the raw rejected row before entering the transaction and passes its
  // hydrated snapshot explicitly; re-reading it through the runtime parser must stay fail-closed.
  const canonicalPreviousEntry =
    options.allowStoredAliases && options.previousEntry !== undefined
      ? (options.previousEntry ?? undefined)
      : readExactSessionEntryRow(database, sessionKey)?.entry;
  if (canonicalPreviousEntry?.sandbox === "required") {
    if (
      normalizedEntry.sandbox !== "required" ||
      normalizedEntry.createdVia !== canonicalPreviousEntry.createdVia ||
      normalizedEntry.createdAt !== canonicalPreviousEntry.createdAt ||
      !isDeepStrictEqual(normalizedEntry.createdActor, canonicalPreviousEntry.createdActor)
    ) {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "blocked role-required session creation provenance downgrade",
        { agentId: database.agentId, sessionKey },
      );
    }
  }
  // Doctor/import owners validate and select a whole creator stamp across aliases.
  // Preserve their selection unless this canonical node already owns required isolation;
  // ordinary writes cannot restamp a logical node's creator.
  if (!options.allowStoredAliases || canonicalPreviousEntry?.sandbox === "required") {
    normalizedEntry = preserveCreationStamp(normalizedEntry, canonicalPreviousEntry);
  }
  const previousEntry =
    options.previousEntry === undefined
      ? canonicalPreviousEntry
      : (options.previousEntry ?? undefined);
  if (
    options.consumePendingReset !== true &&
    previousEntry?.updatedAt === 0 &&
    previousEntry.sessionId === normalizedEntry.sessionId &&
    previousEntry.lifecycleRevision === normalizedEntry.lifecycleRevision
  ) {
    // Same-lifecycle bookkeeping cannot cancel the one-time reset owed by legacy state.
    normalizedEntry.updatedAt = 0;
  }
  const updatedAt = normalizedEntry.updatedAt;
  // The lifecycle-selected entry owns visibility copy-forward semantics.
  if (previousEntry && previousEntry.sessionId !== normalizedEntry.sessionId) {
    delete normalizedEntry.visibility;
  }
  // Collaboration rows belong to the exact canonical node being overwritten,
  // which can differ from the selected alias during canonicalization.
  if (canonicalPreviousEntry && canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId) {
    // Doctor merges duplicate logical nodes; suggestions are owned by session_key,
    // not by the transcript generation being replaced. Membership remains winner-only.
    clearSessionCollaborationForKey(database, sessionKey, {
      clearSuggestions: options.preserveNodeSuggestions !== true,
    });
  }
  // Registry writes snapshot the current transcript watermark so recovery can
  // distinguish same-millisecond transcript writes before and after this row.
  const transcriptObservedAt =
    readTranscriptMutationStateInTransaction(database, normalizedEntry.sessionId).updatedAt ??
    updatedAt;
  const boundSessionRoot = bindSessionRoot({ entry: normalizedEntry, sessionKey, updatedAt });
  const conversation = prepareSessionConversationForWrite({
    database,
    entry: normalizedEntry,
    previousEntry,
    ...(options.routeContext !== undefined ? { routeContext: options.routeContext } : {}),
    sessionScope: boundSessionRoot.session_scope,
  });
  if (conversation) {
    upsertConversationIdentity(database, conversation.identity, updatedAt);
  }
  const boundSessionRow = {
    ...boundSessionRoot,
    primary_conversation_id:
      conversation?.role === "primary" ? conversation.identity.conversationRef : null,
    transcript_observed_at: transcriptObservedAt,
  };
  const sessionRow = resolveSessionEntryProvenanceRow({
    boundSessionRow,
    database,
    entry: normalizedEntry,
    previousEntry,
  });
  const sessionNode = bindSessionNode({ entry: normalizedEntry, sessionKey, updatedAt });
  const writeGeneration = trackSessionEntryCacheWrite(database, () => {
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("session_nodes")
        .values(sessionNode)
        .onConflict((conflict) =>
          conflict.column("session_key").doUpdateSet({
            current_session_id: sessionNode.current_session_id,
            entry_json: sessionNode.entry_json,
            entry_valid: sessionNode.entry_valid,
            updated_at: sessionNode.updated_at,
            status: sessionNode.status,
            created_at: sessionNode.created_at,
            created_via: sessionNode.created_via,
            created_actor_type: sessionNode.created_actor_type,
            created_actor_id: sessionNode.created_actor_id,
            project_id: sessionNode.project_id,
            parent_session_key: sessionNode.parent_session_key,
            spawned_by: sessionNode.spawned_by,
            fork_source_session_key: sessionNode.fork_source_session_key,
            fork_source_session_id: sessionNode.fork_source_session_id,
            fork_source_entry_id: sessionNode.fork_source_entry_id,
            label: sessionNode.label,
            display_name: sessionNode.display_name,
            category: sessionNode.category,
            icon: sessionNode.icon,
            pinned_at: sessionNode.pinned_at,
            archived_at: sessionNode.archived_at,
            last_read_at: sessionNode.last_read_at,
            last_interaction_at: sessionNode.last_interaction_at,
            last_activity_at: sessionNode.last_activity_at,
          }),
        ),
    );
    executeSqliteQuerySync(
      database.db,
      db.updateTable("session_nodes").set({ entry_valid: 1 }).where("session_key", "=", sessionKey),
    );
  });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_windows")
      .values(sessionRow)
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: sessionKey,
          previous_session_id: sessionRow.previous_session_id,
          reason: sessionRow.reason,
          session_scope: sessionRow.session_scope,
          transcript_observed_at: transcriptObservedAt,
          session_entry_provenance: sessionRow.session_entry_provenance,
          acp_owned: sessionRow.acp_owned,
          plugin_owner_id: sessionRow.plugin_owner_id,
          hook_external_content_source: sessionRow.hook_external_content_source,
          updated_at: updatedAt,
          started_at: sessionRow.started_at,
          ended_at: sessionRow.ended_at,
          status: sessionRow.status,
          chat_type: sessionRow.chat_type,
          channel: sessionRow.channel,
          account_id: sessionRow.account_id,
          primary_conversation_id: sessionRow.primary_conversation_id,
          model_provider: sessionRow.model_provider,
          model: sessionRow.model,
          agent_harness_id: sessionRow.agent_harness_id,
          parent_session_key: sessionRow.parent_session_key,
          spawned_by: sessionRow.spawned_by,
          display_name: sessionRow.display_name,
        }),
      ),
  );
  if (conversation) {
    linkSessionConversation({
      database,
      ...(previousEntry?.sessionId ? { previousSessionId: previousEntry.sessionId } : {}),
      sessionId: sessionRow.session_id,
      conversation,
      updatedAt,
    });
  }
  publishSessionEntryCacheInvalidation(
    database,
    { sessionKey, entry: normalizedEntry },
    writeGeneration,
  );
  return normalizedEntry;
}
