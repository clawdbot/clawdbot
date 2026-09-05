// Live-node capacity eviction for the SQLite session disk budget.
// Extracted from session-accessor.sqlite-maintenance.ts to stay within max-lines.

import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  parseAgentSessionKey,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import {
  collectActiveSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.shared.js";
import { measureSessionPhysicalDiskUsage, type SessionPhysicalDiskUsage } from "./disk-budget.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  collectProjectedReferencedSessionIds,
  collectSessionStateIdsForEntry,
  planSessionStateDeleteIfUnreferenced,
  readSessionGenerationIdsForKeys,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  SessionEntryMaintenancePlan,
  SessionEntryMaintenanceResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { collectSessionMaintenancePreserveKeysForStore } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import { isRecentSessionMaintenanceEntry } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

/**
 * True when the session key identifies a durable human conversation surface
 * (thread, channel, group, Telegram topic) — the only live nodes the disk
 * budget may destructively reclaim as a last resort.
 */
function isDurableConversationSessionKey(
  sessionKey: string,
  entry: SessionEntry | undefined,
): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  if (parseThreadSessionSuffix(sessionKey).threadId) {
    return true;
  }
  if (
    /^[^:]+:(?:group|channel):.+$/.test(rest) ||
    /^telegram:(?:direct|dm):.+:topic:[^:]+$/.test(rest)
  ) {
    return true;
  }
  const chatType = normalizeLowercaseStringOrEmpty(
    entry?.chatType ?? sessionDeliveryOrigin(entry)?.chatType,
  );
  return chatType === "group" || chatType === "channel" || chatType === "thread";
}

function loadSqliteSessionMaintenanceStore(
  database: OpenClawAgentDatabase,
): Record<string, SessionEntry> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

/** Session ids owned by in-flight work admissions, without live-reference protection. */
export function collectAdmissionProtectedSessionIds(params: {
  database: OpenClawAgentDatabase;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = new Set<string>();
  const admissionIdentities =
    collectActiveSessionWorkAdmissions().get(params.storePath) ?? new Set<string>();
  if (admissionIdentities.size === 0) {
    return protectedSessionIds;
  }

  for (const identity of admissionIdentities) {
    protectedSessionIds.add(identity);
  }
  const normalizedAdmissionKeys = new Set(
    [...admissionIdentities].map((identity) => normalizeStoreSessionKey(identity)),
  );
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_nodes").select(["entry_json", "current_session_id", "session_key"]),
  ).rows;
  for (const row of rows) {
    if (!normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      continue;
    }
    protectedSessionIds.add(row.current_session_id);
    const entry = parseSessionEntryRow(row);
    if (entry) {
      for (const sessionId of collectSessionStateIdsForEntry(entry)) {
        protectedSessionIds.add(sessionId);
      }
    }
  }
  const generationRows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_windows").select(["session_id", "session_key"]),
  ).rows;
  for (const row of generationRows) {
    if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      protectedSessionIds.add(row.session_id);
    }
  }
  return protectedSessionIds;
}

function collectAdmissionProtectedStoreKeys(params: {
  database: OpenClawAgentDatabase;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = collectAdmissionProtectedSessionIds(params);
  if (protectedSessionIds.size === 0) {
    return new Set();
  }
  const keys = new Set<string>();
  const db = getSessionKysely(params.database.db);
  for (const row of executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_nodes").select(["current_session_id", "session_key"]),
  ).rows) {
    if (
      protectedSessionIds.has(row.session_key) ||
      protectedSessionIds.has(row.current_session_id)
    ) {
      keys.add(row.session_key);
    }
  }
  for (const row of executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_windows").select(["session_id", "session_key"]),
  ).rows) {
    if (protectedSessionIds.has(row.session_id)) {
      keys.add(row.session_key);
    }
  }
  return keys;
}

function collectCapacityEligibleLivePreserveKeys(params: {
  baseKeys?: Iterable<string | undefined>;
  database: OpenClawAgentDatabase;
  skipSessionKeys?: ReadonlySet<string>;
  store: Record<string, SessionEntry>;
  storePath: string;
}): Set<string> {
  const preserveKeys =
    collectSessionMaintenancePreserveKeysForStore({
      baseKeys: params.baseKeys,
      storePath: params.storePath,
      store: params.store,
    }) ?? new Set<string>();
  for (const key of params.skipSessionKeys ?? []) {
    preserveKeys.add(key);
  }
  for (const key of collectAdmissionProtectedStoreKeys({
    database: params.database,
    storePath: params.storePath,
  })) {
    preserveKeys.add(key);
  }
  return preserveKeys;
}

function planSqliteLiveEntryRemovals(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  projectedStore: Record<string, SessionEntry>;
  removedEntriesByKey: Map<string, SessionEntry>;
  removedKeys: Set<string>;
}): SessionEntryMaintenancePlan {
  const removedSessionIds = new Set<string>();
  for (const entry of params.removedEntriesByKey.values()) {
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      removedSessionIds.add(sessionId);
    }
  }
  for (const sessionId of readSessionGenerationIdsForKeys(params.database, [
    ...params.removedKeys,
  ])) {
    removedSessionIds.add(sessionId);
  }
  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database: params.database,
    excludedSessionKeys: [...params.removedKeys],
    projectedStore: params.projectedStore,
  });
  const deletePlans: SessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: true,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return {
    entryRemovals: [...params.removedEntriesByKey].map(([sessionKey, entry]) => ({
      expectedEntry: entry,
      sessionKey,
    })),
    stateDeletePlans: deletePlans,
    archived: 0,
    capArchived: 0,
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
  };
}

function resolveLivePreserveRecentMs(preserveRecentMs?: number | null): number | null {
  return preserveRecentMs === undefined
    ? (resolveMaintenanceConfig().preserveRecentMs ?? null)
    : preserveRecentMs;
}

/** Plans at most one oldest capacity-eligible live session_node removal.
 *
 * This is the last-resort disk-budget tier. `capEntryCount` archives ordinary
 * sessions instead of deleting them, so this function bypasses the cap path
 * entirely and directly selects the oldest idle live node for deletion.
 * Always-protected entries (primary, pinned, model-locked, active/admitted,
 * recently active) are never victims.
 */
export function planOldestCapacityEligibleSqliteLiveEntryRemoval(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  skipSessionKeys?: ReadonlySet<string>;
  storePath: string;
  preserveRecentMs?: number | null;
}): SessionEntryMaintenancePlan {
  const store = loadSqliteSessionMaintenanceStore(params.database);
  const preserveKeys = collectCapacityEligibleLivePreserveKeys({
    database: params.database,
    skipSessionKeys: params.skipSessionKeys,
    store,
    storePath: params.storePath,
  });
  const preserveRecentMs = resolveLivePreserveRecentMs(params.preserveRecentMs);

  // Select the single oldest eligible live node. After excluding
  // always-protected and recently active entries, the remainder are idle
  // durable conversations that the disk budget may destructively reclaim.
  let victim: { key: string; entry: SessionEntry } | undefined;
  for (const [key, entry] of Object.entries(store)) {
    if (params.skipSessionKeys?.has(key)) {
      continue;
    }
    if (entry.archivedAt !== undefined) {
      continue;
    }
    if (entry.pinnedAt !== undefined) {
      continue;
    }
    if (entry.modelSelectionLocked === true) {
      continue;
    }
    if (preserveKeys.has(key)) {
      continue;
    }
    const parsed = parseAgentSessionKey(key);
    if (parsed?.rest === "main" || key === "global") {
      continue;
    }
    if (isRecentSessionMaintenanceEntry({ key, entry, preserveRecentMs })) {
      continue;
    }
    // Only durable conversation surfaces (threads, channels, groups, topics)
    // are eligible for last-resort live-node eviction. Ordinary session entries
    // are not destructively reclaimable under the disk budget.
    if (!isDurableConversationSessionKey(key, entry)) {
      continue;
    }
    if (!victim || (entry.updatedAt ?? 0) < (victim.entry.updatedAt ?? 0)) {
      victim = { key, entry };
    }
  }

  if (!victim) {
    return {
      entryRemovals: [],
      stateDeletePlans: [],
      archived: 0,
      capArchived: 0,
      modelRunPruned: 0,
      pruned: 0,
      capped: 0,
    };
  }

  const removedKeys = new Set([victim.key]);
  const removedEntriesByKey = new Map([[victim.key, cloneSessionEntry(victim.entry)]]);
  // The projected store must exclude the victim so collectProjectedReferencedSessionIds
  // does not mark its session id as referenced — otherwise no state delete plan is
  // produced and the session_nodes row survives deletion.
  const projectedStore = { ...store };
  delete projectedStore[victim.key];
  return planSqliteLiveEntryRemovals({
    archiveDirectory: params.archiveDirectory,
    database: params.database,
    projectedStore,
    removedEntriesByKey,
    removedKeys,
  });
}

function sqliteSessionNodeExists(database: OpenClawAgentDatabase, sessionKey: string): boolean {
  const db = getSessionKysely(database.db);
  return (
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select("session_key")
        .where("session_key", "=", sessionKey)
        .limit(1),
    ).rows.length > 0
  );
}

/** Last-resort live-node disk eviction. Historical generations must already be exhausted. */
export async function reclaimSqliteLiveSessionEntriesToHighWater(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  finalizePlans: (
    scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
    plans: readonly SessionEntryMaintenancePlan[],
  ) => Promise<SessionEntryMaintenanceResult>;
  highWaterBytes: number;
  pruneArchivesToHighWater: () => Promise<{
    removedFiles: number;
    usage: SessionPhysicalDiskUsage;
  }>;
  reclaimFreePages: (database: OpenClawAgentDatabase) => void;
  resolved: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">;
  storePath: string;
  usage: SessionPhysicalDiskUsage;
  preserveRecentMs?: number | null;
}): Promise<{
  removedEntries: number;
  removedFiles: number;
  usage: SessionPhysicalDiskUsage;
}> {
  let { usage } = params;
  let removedEntries = 0;
  let removedFiles = 0;
  const skipSessionKeys = new Set<string>();
  const livePlanParams = {
    archiveDirectory: params.archiveDirectory,
    database: params.database,
    skipSessionKeys,
    storePath: params.storePath,
    preserveRecentMs: params.preserveRecentMs,
  };
  while (usage.totalBytes > params.highWaterBytes) {
    const livePlan = planOldestCapacityEligibleSqliteLiveEntryRemoval(livePlanParams);
    const victim = livePlan.entryRemovals[0];
    if (!victim) {
      break;
    }
    const identities = uniqueStrings(
      [
        victim.sessionKey,
        victim.expectedEntry?.sessionId,
        ...readSessionGenerationIdsForKeys(params.database, [victim.sessionKey]),
      ].filter(
        (identity): identity is string => typeof identity === "string" && identity.length > 0,
      ),
    );
    let retargeted = false;
    const published = await runExclusiveSessionLifecycleMutation({
      scope: params.storePath,
      identities,
      run: async () => {
        const fencedPlan = planOldestCapacityEligibleSqliteLiveEntryRemoval(livePlanParams);
        if (fencedPlan.entryRemovals[0]?.sessionKey !== victim.sessionKey) {
          retargeted = true;
          return null;
        }
        return await params.finalizePlans(params.resolved, [fencedPlan]);
      },
    });
    if (retargeted) {
      continue;
    }
    if (!published || sqliteSessionNodeExists(params.database, victim.sessionKey)) {
      skipSessionKeys.add(victim.sessionKey);
      continue;
    }
    removedEntries += 1;
    emitArchivedTranscriptUpdates(published.archivedTranscripts);
    try {
      params.reclaimFreePages(params.database);
    } catch {
      // Best-effort reclamation only.
    }
    usage = await measureSessionPhysicalDiskUsage(params.storePath);
    if (usage.totalBytes > params.highWaterBytes) {
      const repruned = await params.pruneArchivesToHighWater();
      removedFiles += repruned.removedFiles;
      usage = repruned.usage;
    }
  }
  return { removedEntries, removedFiles, usage };
}
