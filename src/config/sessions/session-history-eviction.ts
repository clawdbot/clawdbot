import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  collectActiveSessionWorkAdmissionIdentities,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  hasRetainedSessionTranscriptArchives,
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
  type SessionDiskBudgetSweepResult,
  type SessionPhysicalDiskUsage,
} from "./disk-budget.js";
import { materializeSqliteSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { emitArchivedSqliteTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  collectSqliteSessionStateIdsForEntry,
  deleteMaterializedSqliteSessionStatePlans,
  planSqliteSessionStateDeleteIfUnreferenced,
  readReferencedSqliteSessionIds,
} from "./session-accessor.sqlite-lifecycle-state.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

type SessionHistoryDiskBudgetParams = {
  agentId?: string;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  storePath: string;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "highWaterBytes" | "maxDiskBytes">;
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
  if (await hasRetainedSessionTranscriptArchives(params.storePath)) {
    return { diskBudget, wouldMutate: true };
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const candidates = readHistoricalSessionIds({
    database,
    protectedSessionIds: collectProtectedHistoricalSessionIds({
      database,
      storePath: params.storePath,
    }),
  });
  return { diskBudget, wouldMutate: candidates.length > 0 };
}

function collectProtectedHistoricalSessionIds(params: {
  database: OpenClawAgentDatabase;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = readReferencedSqliteSessionIds(params.database);
  for (const sessionId of collectAdmissionProtectedSessionIds(params)) {
    protectedSessionIds.add(sessionId);
  }
  return protectedSessionIds;
}

/** Session ids owned by in-flight work admissions, without live-reference protection. */
export function collectAdmissionProtectedSessionIds(params: {
  database: OpenClawAgentDatabase;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = new Set<string>();
  const admissionIdentities = collectActiveSessionWorkAdmissionIdentities(params.storePath);
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
    db.selectFrom("session_entries").select(["entry_json", "session_id", "session_key"]),
  ).rows;
  for (const row of rows) {
    if (!normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      continue;
    }
    protectedSessionIds.add(row.session_id);
    const entry = parseSqliteSessionEntryJson(row);
    if (entry) {
      for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
        protectedSessionIds.add(sessionId);
      }
    }
  }
  // Key-scoped admissions must survive rollover: an in-flight run admitted by
  // key may still write to a generation the entry no longer references, so
  // every generation of an admitted key stays off-limits.
  const generationRows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("sessions").select(["session_id", "session_key"]),
  ).rows;
  for (const row of generationRows) {
    if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      protectedSessionIds.add(row.session_id);
    }
  }
  return protectedSessionIds;
}

function readHistoricalSessionIds(params: {
  database: OpenClawAgentDatabase;
  protectedSessionIds: ReadonlySet<string>;
}): string[] {
  const db = getSessionKysely(params.database.db);
  return executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("sessions")
      .select("session_id")
      .orderBy("updated_at", "asc")
      .orderBy("session_id", "asc"),
  ).rows.flatMap((row) => (params.protectedSessionIds.has(row.session_id) ? [] : [row.session_id]));
}

function reclaimSqliteFreePages(database: OpenClawAgentDatabase): void {
  // Committed row deletion first lands in the WAL. TRUNCATE makes that shrink immediately;
  // incremental vacuum can then return free tail pages from the main file without a rewrite.
  database.walMaintenance.checkpoint();
  const row = database.db.prepare("PRAGMA freelist_count").get() as
    | { freelist_count?: unknown }
    | undefined;
  const freePages = Number(row?.freelist_count ?? 0);
  if (Number.isSafeInteger(freePages) && freePages > 0) {
    database.db.exec(`PRAGMA incremental_vacuum(${freePages});`);
  }
  database.walMaintenance.checkpoint();
}

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
    .catch(() => {
      // Best-effort: budget pressure is retried on the next throttled kick.
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
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(resolved);
  let usage: SessionPhysicalDiskUsage = await runExclusiveSqliteSessionWrite(resolved, async () => {
    reclaimSqliteFreePages(database);
    return await measureSessionPhysicalDiskUsage(params.storePath);
  });
  let removedEntries = 0;
  let removedFiles = 0;
  if (usage.totalBytes > highWaterBytes) {
    // Archive pruning shares the session write lock so a concurrent
    // reset/delete cannot race its archive file against the unlink pass.
    const archiveSweep = await runExclusiveSqliteSessionWrite(resolved, async () =>
      pruneSessionTranscriptArchivesToHighWater({
        highWaterBytes,
        storePath: params.storePath,
      }),
    );
    removedFiles = archiveSweep.removedFiles;
    usage = archiveSweep.usage;
  }
  const candidates = readHistoricalSessionIds({
    database,
    protectedSessionIds: collectProtectedHistoricalSessionIds({
      database,
      storePath: params.storePath,
    }),
  });

  for (const sessionId of candidates) {
    if (usage.totalBytes <= highWaterBytes) {
      break;
    }
    const eviction = await runExclusiveSessionLifecycleMutation({
      scope: params.storePath,
      identities: [sessionId],
      run: async () =>
        await runExclusiveSqliteSessionWrite(resolved, async () => {
          const protectedBeforeArchive = collectProtectedHistoricalSessionIds({
            database,
            storePath: params.storePath,
          });
          const plan = planSqliteSessionStateDeleteIfUnreferenced({
            archiveDirectory,
            archiveTranscript: true,
            database,
            reason: "deleted",
            referencedSessionIds: protectedBeforeArchive,
            sessionId,
          });
          if (!plan) {
            return null;
          }

          // Extract-before-delete is the retention invariant. Admission is fenced across archive
          // creation, then rechecked inside the write transaction before any rows are reclaimed.
          const materialized = materializeSqliteSessionStateDeletePlans([plan]);
          let deleted = false;
          let archivedTranscripts: ReturnType<typeof deleteMaterializedSqliteSessionStatePlans> =
            [];
          runOpenClawAgentWriteTransaction((transactionDb) => {
            const protectedAtDelete = collectProtectedHistoricalSessionIds({
              database: transactionDb,
              storePath: params.storePath,
            });
            archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
              transactionDb,
              materialized,
              protectedAtDelete,
            );
            const db = getSessionKysely(transactionDb.db);
            deleted =
              executeSqliteQuerySync(
                transactionDb.db,
                db.selectFrom("sessions").select("session_id").where("session_id", "=", sessionId),
              ).rows.length === 0;
          }, toDatabaseOptions(resolved));
          if (!deleted) {
            return null;
          }
          try {
            // The deletion is committed; checkpoint/incremental-vacuum failure
            // must not hide it from accounting or observers. Pages reclaim on
            // a later pass instead.
            reclaimSqliteFreePages(database);
          } catch {
            // Best-effort reclamation only.
          }
          return {
            archivedTranscripts,
            usage: await measureSessionPhysicalDiskUsage(params.storePath),
          };
        }),
    });
    if (!eviction) {
      continue;
    }
    removedEntries += 1;
    emitArchivedSqliteTranscriptUpdates(eviction.archivedTranscripts);
    usage = eviction.usage;
    if (usage.totalBytes > highWaterBytes) {
      // Reclaim archives (oldest first, including ones this pass committed)
      // before spending another session's rows: each session's data should be
      // destroyed at most once, and pruning an extracted copy beats evicting
      // additional searchable history. No prune runs between an archive write
      // and its row-deletion commit, so a sole copy is never mid-flight here.
      const repruned = await runExclusiveSqliteSessionWrite(resolved, async () =>
        pruneSessionTranscriptArchivesToHighWater({
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
      pruneSessionTranscriptArchivesToHighWater({
        highWaterBytes,
        storePath: params.storePath,
      }),
    );
    removedFiles += finalPrune.removedFiles;
    usage = finalPrune.usage;
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
