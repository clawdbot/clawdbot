import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  linkSessionConversation,
  prepareSessionConversation,
  upsertConversationIdentity,
} from "./session-accessor.sqlite-conversation.js";
import {
  publishSessionEntryCacheInvalidation,
  trackSessionEntryCacheWrite,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  clearSessionCollaborationForKey,
  deleteSessionDeliveryArtifacts,
  deleteSessionNodeArtifacts,
  rehomeLegacySessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import { resolveSessionEntryProvenanceRow } from "./session-accessor.sqlite-provenance.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  normalizeSqliteSessionKey,
} from "./session-accessor.sqlite-scope.js";
import {
  bindSessionNode,
  bindSessionRoot,
  normalizeSessionEntryTimestamp,
} from "./session-accessor.sqlite-session-row.js";
import {
  hasValidSessionEntryIdentity,
  parseSessionEntryJson as parseSessionEntryRow,
} from "./session-accessor.sqlite-status.js";
import { readTranscriptMutationStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  assertCanonicalSessionEntryLineageWrite,
  assertCanonicalSqliteSessionKeysCurrent,
  assertCanonicalSessionKeyWriteMatchesDatabase,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import {
  collectSessionEntryLookupKeys,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
export { collectSessionEntryLookupKeys } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_nodes"]>;
export type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  legacyKeys: string[];
  row: SessionEntryRow;
};
type SqliteSessionEntrySelectionSnapshot = {
  selected: ResolvedSessionEntryRow | undefined;
  selectedRows: Array<{ entry: SessionEntry; sessionKey: string }>;
};
type SqliteLifecycleTargetSnapshot = {
  primary: { entry: SessionEntry; key: string } | undefined;
  rows: Array<{ entry: SessionEntry; sessionKey: string }>;
};

function parseReadableSqliteSessionEntryRow(
  database: Pick<OpenClawAgentDatabase, "db">,
  row: Pick<SessionEntryRow, "current_session_id" | "entry_json" | "session_key" | "updated_at">,
): SessionEntry | null {
  const record = parseSqliteSessionEntryRecord(row);
  if (record) {
    const entry = projectCanonicalSessionEntryShape(record);
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

class SqliteSessionMutationConflictError extends Error {
  constructor(operationLabel: string) {
    super(`SQLite session state changed while preparing ${operationLabel}`);
    this.name = "SqliteSessionMutationConflictError";
  }
}

export function readSessionIdentitySnapshot(
  database: OpenClawAgentDatabase,
  sessionKeys: Iterable<string>,
): Map<string, SessionEntry> {
  const snapshot = new Map<string, SessionEntry>();
  for (const sessionKey of uniqueStrings([...sessionKeys].map((key) => key.trim()))) {
    const row = readExactSessionEntryRow(database, sessionKey);
    if (row) {
      snapshot.set(sessionKey, cloneSessionEntry(row.entry));
    }
  }
  return snapshot;
}

export function createSessionIdentitySnapshot(
  rows: readonly { entry: SessionEntry; sessionKey: string }[],
): Map<string, SessionEntry> {
  return new Map(rows.map((row) => [row.sessionKey, cloneSessionEntry(row.entry)]));
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
    selected = { entry, legacyKeys: [], row };
  }
  return selected;
}

// Async updaters prepare against this complete selection. Capturing alias rows
// prevents the commit phase from deleting a concurrently changed legacy key.
export function readSessionEntrySelectionSnapshot(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  exact: boolean,
): SqliteSessionEntrySelectionSnapshot {
  const selected = exact
    ? readExactSessionEntryRow(database, sessionKey)
    : readSessionEntryRow(database, sessionKey);
  const selectedKeys = collectSessionEntryLookupKeys(database, sessionKey).toSorted();
  return {
    selected,
    selectedRows: selectedKeys.flatMap((candidateKey) => {
      const row = readExactSessionEntryRow(database, candidateKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey: candidateKey }] : [];
    }),
  };
}

export function assertSessionEntrySelectionUnchanged(
  expected: SqliteSessionEntrySelectionSnapshot,
  current: SqliteSessionEntrySelectionSnapshot,
  operationLabel: string,
): void {
  const selectedMatches =
    expected.selected?.row.session_key === current.selected?.row.session_key &&
    sqliteSessionEntriesEqual(expected.selected?.entry, current.selected?.entry);
  if (
    !selectedMatches ||
    !sqliteSessionSnapshotRowsEqual(expected.selectedRows, current.selectedRows)
  ) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}

export function readExactSessionEntryRow(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_nodes").selectAll().where("session_key", "=", sessionKey),
  );
  if (!row) {
    return undefined;
  }
  const entry = parseReadableSqliteSessionEntryRow(database, row);
  return entry ? { entry, legacyKeys: [], row } : undefined;
}

export function readExactSessionEntryJsonForCanonicalRepair(
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
): ResolvedSessionEntryRow | undefined {
  assertCanonicalSqliteSessionKeysCurrent(database);
  return readExactSessionEntryRow(database, sessionKey);
}

export function readSessionEntryStore(
  database: OpenClawAgentDatabase,
  options: { allowCanonicalRepair?: boolean } = {},
): Record<string, SessionEntry> {
  if (options.allowCanonicalRepair !== true) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "entry_json", "session_key", "updated_at"])
      .orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    // Doctor lifecycle projection supplies its separately hydrated expected entry for rejected
    // raw rows; ordinary exact reads still fail loud before a write can replace one.
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

export function readSessionEntryCount(database: OpenClawAgentDatabase): number {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select("entry_json"),
  ).rows;
  return rows.reduce((count, row) => count + (parseSessionEntryRow(row) ? 1 : 0), 0);
}

export function readSessionEntryKeys(database: OpenClawAgentDatabaseReader): string[] {
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["entry_json", "session_key"])
      .orderBy("session_key", "asc"),
  ).rows.flatMap((row) => (parseSessionEntryRow(row) ? [row.session_key] : []));
}

export function resolveLifecyclePrimaryEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  options: { allowCanonicalMove?: boolean } = {},
): { key: string; entry: SessionEntry } | undefined {
  const rows = target.storeKeys.flatMap((key) => {
    const sessionKey = key.trim();
    const row = readExactSessionEntryRow(database, sessionKey);
    return row ? [{ key: sessionKey, entry: row.entry }] : [];
  });
  if (rows.length > 1) {
    throw canonicalSessionKeyMigrationRequiredError(
      `duplicate rows resolve to canonical session key ${target.canonicalKey}`,
    );
  }
  const [row] = rows;
  if (row && row.key !== target.canonicalKey && options.allowCanonicalMove !== true) {
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
  return {
    primary: resolveLifecyclePrimaryEntry(database, normalized, options),
    rows: normalized.storeKeys.flatMap((sessionKey) => {
      const row = readExactSessionEntryRow(database, sessionKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey }] : [];
    }),
  };
}

export function assertLifecycleTargetSnapshotUnchanged(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
  operationLabel: string,
): void {
  const primaryMatches =
    expected.primary?.key === current.primary?.key &&
    sqliteSessionEntriesEqual(expected.primary?.entry, current.primary?.entry);
  if (!primaryMatches || !sqliteSessionSnapshotRowsEqual(expected.rows, current.rows)) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
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
  options: { deleteOwnedWindows?: boolean; deliveryCleanupKeys?: readonly string[] } = {},
): void {
  const db = getSessionKysely(database.db);
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "=", sessionKey),
  ).rows;
  const survivingNodes = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "entry_json", "session_key"])
      .where("session_key", "!=", sessionKey)
      .orderBy("session_key", "asc"),
  ).rows;
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

export function sqliteSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function sqliteSessionSnapshotRowsEqual(
  left: Array<{ entry: SessionEntry; sessionKey: string }>,
  right: Array<{ entry: SessionEntry; sessionKey: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.sessionKey === right[index]?.sessionKey &&
        sqliteSessionEntriesEqual(row.entry, right[index]?.entry),
    )
  );
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
  options: { rehomeMembers?: boolean } = {},
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    rehomeSessionWindows(database, sessionKey, [legacyKey]);
    rehomeLegacySessionNodeArtifacts(database, legacyKey, sessionKey, options);
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
    preserveNodeSuggestions?: boolean;
    previousEntry?: SessionEntry | null;
  } = {},
): void {
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
  const normalizedEntry = normalizeSessionEntryTimestamp(entry);
  if (!hasValidSessionEntryIdentity(normalizedEntry)) {
    throw new Error("Refusing invalid SQLite session entry identity");
  }
  const updatedAt = normalizedEntry.updatedAt;
  // Doctor validated the raw rejected row before entering the transaction and passes its
  // hydrated snapshot explicitly; re-reading it through the runtime parser must stay fail-closed.
  const canonicalPreviousRow =
    options.allowStoredAliases && options.previousEntry !== undefined
      ? undefined
      : readExactSessionEntryRow(database, sessionKey);
  const canonicalPreviousEntry =
    canonicalPreviousRow?.entry ??
    (options.allowStoredAliases && options.previousEntry !== undefined
      ? (options.previousEntry ?? undefined)
      : undefined);
  const previousEntry =
    options.previousEntry === undefined
      ? canonicalPreviousEntry
      : (options.previousEntry ?? undefined);
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
  const conversation = prepareSessionConversation({
    entry: normalizedEntry,
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
            parent_session_key: sessionNode.parent_session_key,
            spawned_by: sessionNode.spawned_by,
            fork_source_session_key: sessionNode.fork_source_session_key,
            fork_source_session_id: sessionNode.fork_source_session_id,
            fork_source_entry_id: sessionNode.fork_source_entry_id,
            label: sessionNode.label,
            display_name: sessionNode.display_name,
            category: sessionNode.category,
            // Clear any retired custom icon without requiring a schema-version migration.
            icon: null,
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
      sessionId: sessionRow.session_id,
      conversation,
      updatedAt,
    });
  }
  publishSessionEntryCacheInvalidation(database, sessionNode, writeGeneration);
}

/** Resolves the parent fork decision using SQLite transcript rows when totals are stale. */
