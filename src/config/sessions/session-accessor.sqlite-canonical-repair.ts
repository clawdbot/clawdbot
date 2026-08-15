import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { listSqliteSessionEntriesWithCanonicalOwnerEvidence } from "./session-accessor.sqlite-canonical-inventory.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { readSessionGenerationIdsForKeys } from "./session-accessor.sqlite-lifecycle-state.js";
import {
  copySessionNodeArtifactsForRepair,
  deleteSessionMembersForRepair,
} from "./session-accessor.sqlite-node-artifacts.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import {
  getSessionKysely,
  resolveSqliteStoreScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { bindSessionWindowEntryProjection } from "./session-accessor.sqlite-session-row.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import {
  deleteSessionTranscriptIndexInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
} from "./session-transcript-index.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

// Doctor-only cross-store transfer. Runtime readers never reconcile aliases.

export function listSqliteSessionEntriesForCanonicalRepair(
  scope: SessionEntryListScope = {},
): Array<SessionEntrySummary & { rawEntryJson?: string }> {
  return listSqliteSessionEntriesWithCanonicalOwnerEvidence(scope);
}

function resolveSqliteCanonicalRepairLookupKeys(
  canonicalKey: string,
  storedKeys: readonly string[],
): string[] {
  return uniqueStrings([
    canonicalKey,
    ...storedKeys,
    ...storedKeys.flatMap((key) => {
      const trimmedKey = key.trim();
      return [trimmedKey, normalizeStoreSessionKey(trimmedKey)];
    }),
  ]);
}

/** Doctor probes only the exact staged target and may replace a malformed partial row. */
export function readExactSessionEntryRowForCanonicalRepair(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  options: { allowMalformedRowRepair?: boolean } = {},
) {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_nodes").selectAll().where("session_key", "=", sessionKey),
  );
  if (!row) {
    return undefined;
  }
  if (row.entry_json === "{}") {
    const retainedWindow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_windows")
        .select("session_id")
        .where("session_id", "=", row.current_session_id)
        .where("session_key", "=", row.session_key),
    );
    if (retainedWindow) {
      return undefined;
    }
  }
  const parsedEntry = parseSessionEntryJson(row);
  if (!parsedEntry && !options.allowMalformedRowRepair) {
    throw canonicalSessionKeyMigrationRequiredError(
      `invalid persisted session row requires repair for ${sessionKey}`,
    );
  }
  return {
    entry:
      parsedEntry ??
      ({ sessionId: row.current_session_id, updatedAt: row.updated_at } satisfies SessionEntry),
    legacyKeys: [],
    row,
  };
}

/** Doctor-only cross-store copy; the source node remains until lifecycle archival succeeds. */
export function copySqliteSessionOwnedStateForCanonicalRepair(params: {
  canonicalKey: string;
  destinationDatabase: OpenClawAgentDatabase;
  preferredEntry?: SessionEntry;
  preferredSessionKey?: string;
  source: { agentId: string; storePath: string };
  sourceEntries: readonly SessionEntry[];
  sourceKeys: readonly string[];
}): void {
  const source = resolveSqliteStoreScope(params.source.storePath, {
    agentId: params.source.agentId,
  });
  const sourceDatabase = openOpenClawAgentDatabase(toDatabaseOptions(source));
  copySqliteSessionOwnedStateForRepair({
    canonicalKey: params.canonicalKey,
    destination: params.destinationDatabase,
    ...(params.preferredEntry ? { preferredEntry: params.preferredEntry } : {}),
    ...(params.preferredSessionKey ? { preferredSessionKey: params.preferredSessionKey } : {}),
    source: sourceDatabase,
    sourceEntries: params.sourceEntries,
    sourceKeys: params.sourceKeys,
  });
}

/** Doctor-only inventory of every generation copied for one canonical-key group. */
export function listSqliteSessionGenerationIdsForCanonicalRepair(params: {
  agentId: string;
  canonicalKey: string;
  sourceKeys: readonly string[];
  storePath: string;
}): string[] {
  const source = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(source));
  return readSessionGenerationIdsForKeys(database, uniqueStrings(params.sourceKeys), {
    exactStoredKeys: true,
  });
}

/** Doctor-only same-store rewrite for delivery attribution owned by removed aliases. */
export function rehomeSqliteSessionDeliveryReferencesForCanonicalRepair(
  database: OpenClawAgentDatabase,
  canonicalKey: string,
  previousKeys: readonly string[],
): void {
  rehomeSqliteSessionDeliveryReferencesForCanonicalRepairBatch(database, [
    { canonicalKey, previousKeys },
  ]);
}

/** Doctor-only batched delivery rewrite with one session identity inventory per database. */
export function rehomeSqliteSessionDeliveryReferencesForCanonicalRepairBatch(
  database: OpenClawAgentDatabase,
  repairs: readonly { canonicalKey: string; previousKeys: readonly string[] }[],
): void {
  if (repairs.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  const storedSessionKeys = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select("session_key"),
  ).rows.map((row) => row.session_key);
  const storedSessionKeySet = new Set(storedSessionKeys);
  const identityCounts = new Map<string, number>();
  for (const sessionKey of storedSessionKeys) {
    const identity = normalizeStoreSessionKey(sessionKey.trim());
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }
  for (const repair of repairs) {
    const ownedKeys = new Set([repair.canonicalKey, ...repair.previousKeys]);
    const ownedIdentityCounts = new Map<string, number>();
    for (const sessionKey of ownedKeys) {
      if (!storedSessionKeySet.has(sessionKey)) {
        continue;
      }
      const identity = normalizeStoreSessionKey(sessionKey.trim());
      ownedIdentityCounts.set(identity, (ownedIdentityCounts.get(identity) ?? 0) + 1);
    }
    const aliases = resolveSqliteCanonicalRepairLookupKeys(
      repair.canonicalKey,
      repair.previousKeys,
    ).filter((key) => {
      if (key === repair.canonicalKey) {
        return false;
      }
      if (ownedKeys.has(key)) {
        return true;
      }
      const identity = normalizeStoreSessionKey(key.trim());
      return (identityCounts.get(identity) ?? 0) <= (ownedIdentityCounts.get(identity) ?? 0);
    });
    if (aliases.length === 0) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("conversation_deliveries")
        .set({ source_session_key: repair.canonicalKey })
        .where("source_session_key", "in", aliases),
    );
  }
}

function copySqliteSessionOwnedStateForRepair(params: {
  canonicalKey: string;
  destination: OpenClawAgentDatabase;
  preferredEntry?: SessionEntry;
  preferredSessionKey?: string;
  source: OpenClawAgentDatabase;
  sourceEntries: readonly SessionEntry[];
  sourceKeys: readonly string[];
}): void {
  const storedSourceKeys = uniqueStrings(params.sourceKeys.filter((key) => key.length > 0));
  if (storedSourceKeys.length === 0) {
    return;
  }
  const sourceKeys = storedSourceKeys;
  const sourceDb = getSessionKysely(params.source.db);
  const destinationDb = getSessionKysely(params.destination.db);
  const entrySessionIds = uniqueStrings(
    params.sourceEntries.flatMap((entry) => [...collectSessionStateIdsForEntry(entry)]),
  );
  const windows = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("session_windows")
      .selectAll()
      .where((eb) =>
        entrySessionIds.length === 0
          ? eb("session_key", "in", sourceKeys)
          : eb.or([eb("session_key", "in", sourceKeys), eb("session_id", "in", entrySessionIds)]),
      ),
  ).rows;
  const sessionIds = uniqueStrings([...windows.map((row) => row.session_id), ...entrySessionIds]);
  const sessionLinks =
    sessionIds.length === 0
      ? []
      : executeSqliteQuerySync(
          params.source.db,
          sourceDb
            .selectFrom("session_conversations")
            .selectAll()
            .where("session_id", "in", sessionIds),
        ).rows;
  const linkedConversationIds = uniqueStrings([
    ...windows.flatMap((row) => (row.primary_conversation_id ? [row.primary_conversation_id] : [])),
    ...sessionLinks.map((row) => row.conversation_id),
  ]);
  const sourceKeyReferences = new Set(sourceKeys);
  const sourceLineageIdentities = new Set(
    sourceKeys.map((key) => normalizeStoreSessionKey(key.trim())),
  );
  const deliveryLookupKeys = resolveSqliteCanonicalRepairLookupKeys(
    params.canonicalKey,
    sourceKeys,
  );
  const competingDeliveryIdentities = new Set(
    executeSqliteQuerySync(
      params.source.db,
      sourceDb.selectFrom("session_nodes").select("session_key"),
    ).rows.flatMap((row) =>
      sourceKeyReferences.has(row.session_key)
        ? []
        : [normalizeStoreSessionKey(row.session_key.trim())],
    ),
  );
  const deliverySourceKeys = deliveryLookupKeys.filter(
    (key) =>
      sourceKeyReferences.has(key) ||
      !competingDeliveryIdentities.has(normalizeStoreSessionKey(key.trim())),
  );
  const deliverySourceKeyReferences = new Set(deliverySourceKeys);
  const deliveries = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("conversation_deliveries")
      .selectAll()
      .where("source_session_key", "in", deliverySourceKeys),
  ).rows;
  const conversationIds = uniqueStrings([
    ...linkedConversationIds,
    ...deliveries.map((delivery) => delivery.conversation_id),
  ]);
  if (conversationIds.length > 0) {
    const conversations = executeSqliteQuerySync(
      params.source.db,
      sourceDb
        .selectFrom("conversations")
        .selectAll()
        .where("conversation_id", "in", conversationIds),
    ).rows;
    for (const conversation of conversations) {
      const { conversation_id: _conversationId, ...replacement } = conversation;
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .insertInto("conversations")
          .values(conversation)
          // conversation_id hashes the same fields as the natural unique identity.
          .onConflict((conflict) => conflict.column("conversation_id").doUpdateSet(replacement)),
      );
    }
    for (const delivery of deliveries) {
      const canonicalDelivery = {
        ...delivery,
        source_session_key:
          delivery.source_session_key !== null &&
          deliverySourceKeyReferences.has(delivery.source_session_key)
            ? params.canonicalKey
            : delivery.source_session_key,
      };
      const { operation_id: _operationId, ...replacement } = canonicalDelivery;
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .insertInto("conversation_deliveries")
          .values(canonicalDelivery)
          .onConflict((conflict) => conflict.column("operation_id").doUpdateSet(replacement)),
      );
    }
  }
  const preferredWindowProjection = params.preferredEntry
    ? bindSessionWindowEntryProjection({
        entry: params.preferredEntry,
        sessionKey: params.canonicalKey,
      })
    : undefined;
  const preferredWindowProvenance = params.preferredEntry
    ? executeSqliteQueryTakeFirstSync(
        params.destination.db,
        destinationDb
          .selectFrom("session_windows")
          .select([
            "session_entry_provenance",
            "acp_owned",
            "plugin_owner_id",
            "hook_external_content_source",
          ])
          .where("session_id", "=", params.preferredEntry.sessionId),
      )
    : undefined;
  for (const window of windows) {
    const canonicalWindow = {
      ...window,
      session_key: params.canonicalKey,
      parent_session_key:
        window.parent_session_key &&
        sourceLineageIdentities.has(normalizeStoreSessionKey(window.parent_session_key.trim()))
          ? params.canonicalKey
          : window.parent_session_key,
      spawned_by:
        window.spawned_by &&
        sourceLineageIdentities.has(normalizeStoreSessionKey(window.spawned_by.trim()))
          ? params.canonicalKey
          : window.spawned_by,
      ...(preferredWindowProjection && window.session_id === params.preferredEntry?.sessionId
        ? { ...preferredWindowProjection, ...preferredWindowProvenance }
        : {}),
    };
    const { session_id: _sessionId, ...replacement } = {
      ...canonicalWindow,
    };
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .insertInto("session_windows")
        .values(canonicalWindow)
        .onConflict((conflict) => conflict.column("session_id").doUpdateSet(replacement)),
    );
  }
  const copiedWindowIds = new Set(windows.map((row) => row.session_id));
  for (const sessionId of entrySessionIds) {
    if (copiedWindowIds.has(sessionId)) {
      continue;
    }
    const entry =
      (params.preferredEntry?.sessionId === sessionId ? params.preferredEntry : undefined) ??
      params.sourceEntries.find((candidate) => candidate.sessionId === sessionId) ??
      params.sourceEntries.find((candidate) =>
        new Set(collectSessionStateIdsForEntry(candidate)).has(sessionId),
      );
    const updatedAt = entry?.updatedAt ?? Date.now();
    const recoveryWindow = {
      session_key: params.canonicalKey,
      previous_session_id:
        entry?.sessionId === sessionId ? (entry.previousSessionId ?? null) : null,
      reason: "recovery",
      session_scope: "conversation",
      created_at: updatedAt,
      updated_at: updatedAt,
    } as const;
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .insertInto("session_windows")
        .values({
          session_id: sessionId,
          ...recoveryWindow,
        })
        .onConflict((conflict) =>
          conflict.column("session_id").doUpdateSet({ session_key: params.canonicalKey }),
        ),
    );
  }
  for (const link of sessionLinks) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb
        .insertInto("session_conversations")
        .values(link)
        .onConflict((conflict) =>
          conflict.columns(["session_id", "conversation_id", "role"]).doUpdateSet({
            first_seen_at: link.first_seen_at,
            last_seen_at: link.last_seen_at,
          }),
        ),
    );
  }
  for (const sessionId of sessionIds) {
    const replaced = copySqliteSessionGenerationRows({
      destination: params.destination,
      sessionId,
      source: params.source,
      sourceWindowPresent: copiedWindowIds.has(sessionId),
    });
    if (!replaced) {
      continue;
    }
    // Search and active-event tables are derived from transcript_events; force their canonical rebuild.
    deleteSessionTranscriptIndexInTransaction(params.destination.db, sessionId);
    reconcileSessionTranscriptIndexInTransaction(params.destination.db, sessionId);
    publishSessionEntryCacheInvalidation(params.destination);
  }
  // Membership is authorization state and follows the selected winner. Boards,
  // suggestions, and heartbeat state merge by their own revision/id contracts.
  deleteSessionMembersForRepair(params.destination, params.canonicalKey);
  copySessionNodeArtifactsForRepair(
    params.source,
    params.destination,
    sourceKeys,
    params.canonicalKey,
    { includeMembers: false },
  );
  copySessionNodeArtifactsForRepair(
    params.source,
    params.destination,
    params.preferredSessionKey ? [params.preferredSessionKey] : sourceKeys,
    params.canonicalKey,
  );
}

function copySqliteSessionGenerationRows(params: {
  destination: OpenClawAgentDatabase;
  sessionId: string;
  source: OpenClawAgentDatabase;
  sourceWindowPresent: boolean;
}): boolean {
  const sourceDb = getSessionKysely(params.source.db);
  const destinationDb = getSessionKysely(params.destination.db);
  const transcriptEvents = executeSqliteQuerySync(
    params.source.db,
    sourceDb.selectFrom("transcript_events").selectAll().where("session_id", "=", params.sessionId),
  ).rows;
  const transcriptIdentities = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("transcript_event_identities")
      .selectAll()
      .where("session_id", "=", params.sessionId),
  ).rows;
  const rewriteWatermarks = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("transcript_rewrite_watermarks")
      .selectAll()
      .where("session_id", "=", params.sessionId),
  ).rows;
  const trajectoryEvents = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("trajectory_runtime_events")
      .selectAll()
      .where("session_id", "=", params.sessionId),
  ).rows;
  const parentStreamEvents = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("acp_parent_stream_events")
      .selectAll()
      .where("session_id", "=", params.sessionId),
  ).rows;
  if (
    !params.sourceWindowPresent &&
    transcriptEvents.length === 0 &&
    transcriptIdentities.length === 0 &&
    rewriteWatermarks.length === 0 &&
    trajectoryEvents.length === 0 &&
    parentStreamEvents.length === 0
  ) {
    return false;
  }
  for (const table of [
    "transcript_event_identities",
    "transcript_events",
    "transcript_rewrite_watermarks",
    "trajectory_runtime_events",
    "acp_parent_stream_events",
  ] as const) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.deleteFrom(table).where("session_id", "=", params.sessionId),
    );
  }
  for (const row of transcriptEvents) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.insertInto("transcript_events").values(row),
    );
  }
  for (const row of transcriptIdentities) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.insertInto("transcript_event_identities").values(row),
    );
  }
  for (const row of rewriteWatermarks) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.insertInto("transcript_rewrite_watermarks").values(row),
    );
  }
  for (const row of trajectoryEvents) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.insertInto("trajectory_runtime_events").values(row),
    );
  }
  for (const row of parentStreamEvents) {
    executeSqliteQuerySync(
      params.destination.db,
      destinationDb.insertInto("acp_parent_stream_events").values(row),
    );
  }
  return true;
}
