import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  collectActiveSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  hasRetainedSessionTranscriptArchives,
  measureSessionPhysicalDiskUsage,
  type SessionDiskBudgetSweepResult,
} from "./disk-budget.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  collectSessionStateIdsForEntry,
  planSessionStateDeleteIfUnreferenced,
  readReferencedSessionIds,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { refreshSqliteSessionPlannerStatisticsBestEffort } from "./session-accessor.sqlite-maintenance.js";
import {
  createHistoryEvictionReclamationPlan,
  runExclusiveSqliteSessionReclamation,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import {
  hasCanonicalSessionTranscriptArchives,
  pruneAllSessionTranscriptArchivesToHighWater,
  reclaimSqliteFreePages,
} from "./session-history-archive-pruning.js";
import { deleteDiskBudgetArchivedSessionEntry } from "./session-history-entry-eviction.runtime.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  isSessionEntryDiskBudgetEvictable,
  isRecentSessionMaintenanceEntry,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type SessionHistoryDiskBudgetParams = {
  agentId?: string;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  storePath: string;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "highWaterBytes" | "maxDiskBytes"> &
    Partial<Pick<ResolvedSessionMaintenanceConfig, "preserveRecentMs">>;
};

function createPhysicalBudgetResult(params: {
  totalBytesBefore: number;
  totalBytesAfter?: number;
  removedEntries?: number;
  removedFiles?: number;
  maxBytes: number;
  highWaterBytes: number;
}): SessionDiskBudgetSweepResult {
  const totalBytesAfter = params.totalBytesAfter ?? params.totalBytesBefore;
  return {
    totalBytesBefore: params.totalBytesBefore,
    totalBytesAfter,
    removedFiles: params.removedFiles ?? 0,
    removedEntries: params.removedEntries ?? 0,
    freedBytes: Math.max(0, params.totalBytesBefore - totalBytesAfter),
    maxBytes: params.maxBytes,
    highWaterBytes: params.highWaterBytes,
    overBudget: params.totalBytesBefore > params.maxBytes,
  };
}

/** Reports the same physical total enforce mode compares, without projecting logical row bytes. */
export async function inspectSqliteSessionHistoryDiskBudget(
  params: SessionHistoryDiskBudgetParams,
): Promise<{ diskBudget: SessionDiskBudgetSweepResult | null; wouldMutate: boolean }> {
  const { highWaterBytes, maxDiskBytes } = params.maintenance;
  if (maxDiskBytes == null || highWaterBytes == null) {
    return { diskBudget: null, wouldMutate: false };
  }
  const usage = await measureSessionPhysicalDiskUsage(params.storePath);
  const diskBudget = createPhysicalBudgetResult({
    totalBytesBefore: usage.totalBytes,
    maxBytes: maxDiskBytes,
    highWaterBytes,
  });
  if (!diskBudget.overBudget || params.mode !== "enforce") {
    return { diskBudget, wouldMutate: false };
  }
  // Predict only definite reclamation: prunable archives or unprotected
  // historical generations. Checkpoint-only byte reclamation stays out of the
  // preview; applied summaries report it via their byte-decrease predicate.
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  const databaseOptions = toDatabaseOptions(resolved);
  if (
    hasCanonicalSessionTranscriptArchives(databaseOptions) ||
    (await hasRetainedSessionTranscriptArchives(params.storePath))
  ) {
    return { diskBudget, wouldMutate: true };
  }
  const candidates = readHistoricalSessionIds({
    databaseOptions,
    preserveRecentMs: params.maintenance.preserveRecentMs,
    storePath: params.storePath,
  });
  const archivedCandidates = readDiskEvictableArchivedSessionBatch({
    databaseOptions,
    limit: 1,
    preserveRecentMs: params.maintenance.preserveRecentMs,
  });
  return {
    diskBudget,
    wouldMutate: candidates.length > 0 || archivedCandidates.candidates.length > 0,
  };
}

function collectProtectedHistoricalSessionIds(params: {
  database: OpenClawAgentDatabase;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = readReferencedSessionIds(params.database);
  for (const sessionId of collectAdmissionProtectedSessionIds(params)) {
    protectedSessionIds.add(sessionId);
  }
  return protectedSessionIds;
}

function collectRecentSessionHistoryIds(params: {
  database: OpenClawAgentDatabase;
  preserveRecentMs?: number | null;
}): Set<string> {
  if (params.preserveRecentMs == null) {
    return new Set();
  }
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
      .select([
        "session_nodes.current_session_id",
        "session_nodes.entry_json",
        "session_nodes.session_key",
        "session_nodes.updated_at",
        "session_windows.session_id",
      ]),
  ).rows;
  return new Set(
    rows.flatMap((row) => {
      const entry = parseSessionEntryJson(row);
      return entry &&
        isRecentSessionMaintenanceEntry({
          key: row.session_key,
          entry,
          preserveRecentMs: params.preserveRecentMs,
        })
        ? [row.session_id]
        : [];
    }),
  );
}

function isRecentHistoricalSessionId(params: {
  database: OpenClawAgentDatabase;
  preserveRecentMs?: number | null;
  sessionId: string;
}): boolean {
  if (params.preserveRecentMs == null) {
    return false;
  }
  const db = getSessionKysely(params.database.db);
  const row = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
      .select([
        "session_nodes.current_session_id",
        "session_nodes.entry_json",
        "session_nodes.session_key",
        "session_nodes.updated_at",
      ])
      .where("session_windows.session_id", "=", params.sessionId),
  ).rows[0];
  if (!row) {
    return false;
  }
  const entry = parseSessionEntryJson(row);
  return Boolean(
    entry &&
    isRecentSessionMaintenanceEntry({
      key: row.session_key,
      entry,
      preserveRecentMs: params.preserveRecentMs,
    }),
  );
}

function collectCandidateProtectedHistoricalSessionIds(params: {
  database: OpenClawAgentDatabase;
  preserveRecentMs?: number | null;
  sessionId: string;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = collectProtectedHistoricalSessionIds(params);
  if (isRecentHistoricalSessionId(params)) {
    protectedSessionIds.add(params.sessionId);
  }
  return protectedSessionIds;
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

  // Admissions may carry either the backing session id or its live session key. Protect both,
  // then resolve admitted keys through their entries so cleanup cannot reclaim active work.
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
    const entry = parseSessionEntryJson(row);
    if (entry) {
      for (const sessionId of collectSessionStateIdsForEntry(entry)) {
        protectedSessionIds.add(sessionId);
      }
    }
  }
  // Key-scoped admissions must survive rollover: an in-flight run admitted by
  // key may still write to a generation the entry no longer references, so
  // every generation of an admitted key stays off-limits.
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

function readHistoricalSessionIds(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  preserveRecentMs?: number | null;
  storePath: string;
}): string[] {
  // openclaw-agent-db.ts cache rule: LRU eviction closes idle handles across awaits.
  const database = openOpenClawAgentDatabase(params.databaseOptions);
  const scope = { ...params, database };
  const protectedSessionIds = collectProtectedHistoricalSessionIds(scope);
  for (const sessionId of collectRecentSessionHistoryIds(scope)) {
    protectedSessionIds.add(sessionId);
  }
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_id")
      .orderBy("updated_at", "asc")
      .orderBy("session_id", "asc"),
  ).rows.flatMap((row) => (protectedSessionIds.has(row.session_id) ? [] : [row.session_id]));
}

type DiskEvictableArchivedSession = {
  archivedAt: number;
  entry: SessionEntry;
  sessionKey: string;
};

const DISK_EVICTABLE_ARCHIVE_BATCH_SIZE = 64;

function readDiskEvictableArchivedSessionBatch(params: {
  after?: { archivedAt: number; sessionKey: string };
  databaseOptions: OpenClawAgentDatabaseOptions;
  limit?: number;
  preserveRecentMs?: number | null;
}): {
  candidates: DiskEvictableArchivedSession[];
  cursor?: { archivedAt: number; sessionKey: string };
  exhausted: boolean;
} {
  const limit = Math.max(1, params.limit ?? DISK_EVICTABLE_ARCHIVE_BATCH_SIZE);
  const candidates: DiskEvictableArchivedSession[] = [];
  let cursor = params.after;
  while (candidates.length < limit) {
    // The agent DB cache may evict idle handles across the caller's async deletion/measurement.
    // Reopen for each bounded page instead of retaining a Kysely handle across those awaits.
    const database = openOpenClawAgentDatabase(params.databaseOptions);
    const db = getSessionKysely(database.db);
    let query = db
      .selectFrom("session_nodes")
      .select(["archived_at", "current_session_id", "entry_json", "session_key", "updated_at"])
      .where("archived_at", "is not", null)
      .orderBy("archived_at", "asc")
      .orderBy("session_key", "asc")
      .limit(DISK_EVICTABLE_ARCHIVE_BATCH_SIZE);
    if (cursor) {
      const after = cursor;
      query = query.where((eb) =>
        eb.or([
          eb("archived_at", ">", after.archivedAt),
          eb.and([
            eb("archived_at", "=", after.archivedAt),
            eb("session_key", ">", after.sessionKey),
          ]),
        ]),
      );
    }
    const rows = executeSqliteQuerySync(database.db, query).rows;
    let scanned = 0;
    for (const row of rows) {
      scanned += 1;
      if (row.archived_at == null) {
        continue;
      }
      cursor = { archivedAt: row.archived_at, sessionKey: row.session_key };
      const entry = parseSessionEntryJson(row);
      if (
        entry &&
        isSessionEntryDiskBudgetEvictable({
          key: row.session_key,
          entry,
          preserveRecentMs: params.preserveRecentMs,
        })
      ) {
        candidates.push({ archivedAt: row.archived_at, entry, sessionKey: row.session_key });
        if (candidates.length >= limit) {
          break;
        }
      }
    }
    const exhausted = rows.length < DISK_EVICTABLE_ARCHIVE_BATCH_SIZE && scanned === rows.length;
    if (candidates.length >= limit || exhausted) {
      return { candidates, ...(cursor ? { cursor } : {}), exhausted };
    }
  }
  return { candidates, ...(cursor ? { cursor } : {}), exhausted: false };
}

const log = createSubsystemLogger("sessions/history-eviction");

const PHYSICAL_BUDGET_CHECK_INTERVAL_MS = 30 * 60 * 1000;
// Single-slot per store: ordinary entry writes kick a throttled background
// budget pass so an over-budget database self-heals without waiting for a
// manual `sessions cleanup` invocation.
const budgetKickStateByStore = new Map<
  string,
  { lastCheckAt: number; running: boolean; pendingForce: boolean }
>();

/** Fire-and-forget budget pass from the ordinary entry-write maintenance seam. */
export function kickSessionHistoryDiskBudgetMaintenance(params: {
  agentId?: string;
  storePath: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  now?: number;
  /** Bypass the throttle interval; still single-slot per store. Used after
      explicit deletion, which can double usage via freshly written archives. */
  force?: boolean;
}): void {
  if (
    params.agentId &&
    isIncognitoOpenClawAgentSqlitePath(params.storePath, { agentId: params.agentId })
  ) {
    return;
  }
  const maintenance = params.maintenanceConfig ?? resolveMaintenanceConfig();
  if (
    maintenance.mode !== "enforce" ||
    maintenance.maxDiskBytes == null ||
    maintenance.highWaterBytes == null
  ) {
    return;
  }
  const now = params.now ?? Date.now();
  const state = budgetKickStateByStore.get(params.storePath) ?? {
    lastCheckAt: 0,
    running: false,
    pendingForce: false,
  };
  if (state.running) {
    // A running pass may already have taken its last measurement; a forced
    // kick (post-delete spike) must not be dropped or the store could stay
    // over budget until the next unrelated write.
    state.pendingForce = state.pendingForce || params.force === true;
    budgetKickStateByStore.set(params.storePath, state);
    return;
  }
  if (!params.force && now - state.lastCheckAt < PHYSICAL_BUDGET_CHECK_INTERVAL_MS) {
    // Dropped, not deferred: every entry write (including heartbeats) re-kicks,
    // so a store that goes over budget is rechecked on the next activity.
    // Reset/delete use force and bypass this window entirely.
    return;
  }
  state.lastCheckAt = now;
  state.running = true;
  budgetKickStateByStore.set(params.storePath, state);
  void enforceSqliteSessionHistoryDiskBudget({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    storePath: params.storePath,
    mode: maintenance.mode,
    maintenance,
  })
    .catch((error: unknown) => {
      // Best-effort: budget pressure is retried on the next throttled kick,
      // but a persistently failing sweep must stay operator-visible — silent
      // failure here means unbounded disk growth with no signal.
      log.warn("session history disk-budget sweep failed; retrying on next kick", {
        error,
        storePath: params.storePath,
      });
    })
    .finally(() => {
      state.running = false;
      if (state.pendingForce) {
        state.pendingForce = false;
        kickSessionHistoryDiskBudgetMaintenance({ ...params, force: true });
      }
    });
}

// One enforcement pass per store at a time: overlapping passes (background
// kick vs `sessions cleanup`) would evict on stale usage measurements and
// prune each other's freshly extracted archives.
const SESSION_HISTORY_MAINTENANCE_QUEUES = new Map<string, StoreWriterQueue>();

/** Extracts historical sessions durably before reclaiming their SQLite rows. */
export async function enforceSqliteSessionHistoryDiskBudget(
  params: SessionHistoryDiskBudgetParams,
): Promise<SessionDiskBudgetSweepResult | null> {
  return await runQueuedStoreWrite({
    queues: SESSION_HISTORY_MAINTENANCE_QUEUES,
    storePath: params.storePath,
    label: "enforceSqliteSessionHistoryDiskBudget",
    fn: async () => await enforceSessionHistoryMaintenanceSerialized(params),
  });
}

// Reclaims checkpointable pages, retained archives, then historical SQLite
// rows. Unreferenced session-dir artifacts (orphan transcripts, stale blobs)
// are owned by per-save store maintenance and `sessions cleanup`, not by this
// supplementary pressure pass.
async function enforceSessionHistoryMaintenanceSerialized(
  params: SessionHistoryDiskBudgetParams,
): Promise<SessionDiskBudgetSweepResult | null> {
  const { highWaterBytes, maxDiskBytes } = params.maintenance;
  if (maxDiskBytes == null || highWaterBytes == null) {
    return null;
  }
  const initialUsage = await measureSessionPhysicalDiskUsage(params.storePath);
  if (initialUsage.totalBytes <= maxDiskBytes || params.mode === "warn") {
    return createPhysicalBudgetResult({
      totalBytesBefore: initialUsage.totalBytes,
      maxBytes: maxDiskBytes,
      highWaterBytes,
    });
  }

  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  const databaseOptions = toDatabaseOptions(resolved);
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(resolved);
  let { usage, removedFiles } = await runExclusiveSqliteSessionWrite(resolved, async () =>
    pruneAllSessionTranscriptArchivesToHighWater({
      archiveDirectory,
      databaseOptions,
      highWaterBytes,
      storePath: params.storePath,
    }),
  );
  let removedEntries = 0;
  const candidates = readHistoricalSessionIds({
    databaseOptions,
    preserveRecentMs: params.maintenance.preserveRecentMs,
    storePath: params.storePath,
  });

  for (const sessionId of candidates) {
    if (usage.totalBytes <= highWaterBytes) {
      break;
    }
    const eviction = await runExclusiveSessionLifecycleMutation({
      scope: params.storePath,
      identities: [sessionId],
      run: async () => {
        const plan = await runExclusiveSqliteSessionWrite(resolved, async () => {
          // openclaw-agent-db.ts cache rule: LRU eviction closes idle handles across awaits.
          const database = openOpenClawAgentDatabase(databaseOptions);
          const protectedBeforeArchive = collectCandidateProtectedHistoricalSessionIds({
            database,
            preserveRecentMs: params.maintenance.preserveRecentMs,
            sessionId,
            storePath: params.storePath,
          });
          return planSessionStateDeleteIfUnreferenced({
            archiveDirectory,
            archiveTranscript: true,
            database,
            reason: "deleted",
            referencedSessionIds: protectedBeforeArchive,
            sessionId,
          });
        });
        if (!plan) {
          return null;
        }
        // Extract-before-delete is the retention invariant. The lifecycle hold
        // fences admission while the store writer is released for archive I/O.
        const committedArchives = await runExclusiveSqliteSessionReclamation(async () => {
          const materialized = await materializeSessionStateDeletePlans([plan]);
          return await runExclusiveSqliteSessionWrite(resolved, async () => {
            const database = openOpenClawAgentDatabase(databaseOptions);
            const reclamationPlan = createHistoryEvictionReclamationPlan({
              databaseOptions,
              materializedPlans: materialized,
              protectedSessionIds: collectCandidateProtectedHistoricalSessionIds({
                database,
                preserveRecentMs: params.maintenance.preserveRecentMs,
                sessionId,
                storePath: params.storePath,
              }),
              sessionId,
            });
            const reclaimed = await runSqliteSessionReclamation({
              forceInProcess: false,
              plan: reclamationPlan,
            });
            if (reclaimed.kind !== reclamationPlan.kind) {
              throw new Error(
                `SQLite session reclamation returned ${reclaimed.kind} for ${reclamationPlan.kind}`,
              );
            }
            if (!reclaimed.value.deleted) {
              return null;
            }
            return reclaimed.value.archivedTranscripts;
          });
        });
        if (!committedArchives) {
          return null;
        }
        return {
          archivedTranscripts: committedArchives,
        };
      },
    });
    if (!eviction) {
      continue;
    }
    // The lifecycle and SQLite writer lanes are both released before file I/O;
    // publication reacquires the writer only for its short status commit.
    const publishedArchives = await publishSessionStateArchives(
      resolved,
      eviction.archivedTranscripts,
    );
    removedEntries += 1;
    emitArchivedTranscriptUpdates(publishedArchives);
    // Publication adds both the derived file and SQLite status WAL after the
    // deletion measurement. Re-read physical usage before declaring high water.
    usage = await measureSessionPhysicalDiskUsage(params.storePath);
    if (usage.totalBytes > highWaterBytes) {
      // Reclaim archives (oldest first, including ones this pass committed)
      // before spending another session's rows: each session's data should be
      // destroyed at most once, and pruning an extracted copy beats evicting
      // additional searchable history. No prune runs between an archive write
      // and its row-deletion commit, so a sole copy is never mid-flight here.
      const repruned = await runExclusiveSqliteSessionWrite(resolved, async () =>
        pruneAllSessionTranscriptArchivesToHighWater({
          archiveDirectory,
          databaseOptions,
          highWaterBytes,
          storePath: params.storePath,
        }),
      );
      removedFiles += repruned.removedFiles;
      usage = repruned.usage;
    }
  }

  if (usage.totalBytes > highWaterBytes) {
    // Candidates are exhausted but archives may remain; finish the pass at the
    // target instead of returning over budget with removable artifacts.
    const finalPrune = await runExclusiveSqliteSessionWrite(resolved, async () =>
      pruneAllSessionTranscriptArchivesToHighWater({
        archiveDirectory,
        databaseOptions,
        highWaterBytes,
        storePath: params.storePath,
      }),
    );
    removedFiles += finalPrune.removedFiles;
    usage = finalPrune.usage;
  }

  if (usage.totalBytes > highWaterBytes) {
    let after: { archivedAt: number; sessionKey: string } | undefined;
    while (usage.totalBytes > highWaterBytes) {
      const batch = readDiskEvictableArchivedSessionBatch({
        ...(after ? { after } : {}),
        databaseOptions,
        preserveRecentMs: params.maintenance.preserveRecentMs,
      });
      if (batch.candidates.length === 0) {
        break;
      }
      after = batch.cursor;
      for (const candidate of batch.candidates) {
        if (usage.totalBytes <= highWaterBytes) {
          break;
        }
        const deletion = await runExclusiveSessionLifecycleMutation({
          scope: params.storePath,
          identities: [candidate.sessionKey, candidate.entry.sessionId],
          run: async () =>
            await deleteDiskBudgetArchivedSessionEntry({
              ...(params.agentId ? { agentId: params.agentId } : {}),
              archiveTranscript: false,
              deleteDeliveryArtifacts: true,
              deleteTranscriptWithoutArchive: true,
              expectedEntry: candidate.entry,
              expectedSessionId: candidate.entry.sessionId,
              storePath: params.storePath,
              target: { canonicalKey: candidate.sessionKey, storeKeys: [candidate.sessionKey] },
            }),
        });
        if (!deletion.deleted) {
          continue;
        }
        removedEntries += 1;
        await runExclusiveSqliteSessionWrite(resolved, async () => {
          try {
            await reclaimSqliteFreePages(databaseOptions);
          } catch {
            // The durable deletion succeeded; a later pass can reclaim pages.
          }
        });
        usage = await measureSessionPhysicalDiskUsage(params.storePath);
      }
      if (batch.exhausted) {
        break;
      }
    }
  }
  if (removedEntries > 0) {
    await refreshSqliteSessionPlannerStatisticsBestEffort(resolved, removedEntries);
    usage = await measureSessionPhysicalDiskUsage(params.storePath);
  }

  return createPhysicalBudgetResult({
    totalBytesBefore: initialUsage.totalBytes,
    totalBytesAfter: usage.totalBytes,
    removedEntries,
    removedFiles,
    maxBytes: maxDiskBytes,
    highWaterBytes,
  });
}
