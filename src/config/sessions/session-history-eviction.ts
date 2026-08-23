import fs from "node:fs";
import path from "node:path";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  collectActiveSessionWorkAdmissionIdentities,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
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
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  collectSessionStateIdsForEntry,
  deleteMaterializedSessionStatePlans,
  planSessionStateDeleteIfUnreferenced,
  readReferencedSessionIds,
} from "./session-accessor.sqlite-lifecycle-state.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  isRecentSessionMaintenanceEntry,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

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
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  if (
    hasCanonicalSessionTranscriptArchives(database) ||
    (await hasRetainedSessionTranscriptArchives(params.storePath))
  ) {
    return { diskBudget, wouldMutate: true };
  }
  const candidates = readHistoricalSessionIds({
    database,
    protectedSessionIds: collectInitialProtectedHistoricalSessionIds({
      database,
      preserveRecentMs: params.maintenance.preserveRecentMs,
      storePath: params.storePath,
    }),
  });
  return { diskBudget, wouldMutate: candidates.length > 0 };
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

function collectInitialProtectedHistoricalSessionIds(params: {
  database: OpenClawAgentDatabase;
  preserveRecentMs?: number | null;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = collectProtectedHistoricalSessionIds(params);
  for (const sessionId of collectRecentSessionHistoryIds(params)) {
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
  database: OpenClawAgentDatabase;
  protectedSessionIds: ReadonlySet<string>;
}): string[] {
  const db = getSessionKysely(params.database.db);
  return executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
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

function hasCanonicalSessionTranscriptArchives(database: OpenClawAgentDatabase): boolean {
  const db = getSessionKysely(database.db);
  const table = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("sqlite_schema")
      .select("name")
      .where("type", "=", "table")
      .where("name", "=", "session_transcript_archives"),
  ).rows[0];
  if (!table) {
    return false;
  }
  return (
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select("session_id")
        .where("published_at", "is not", null)
        .limit(1),
    ).rows.length > 0
  );
}

function readUnpublishedSessionTranscriptArchiveNames(
  database: OpenClawAgentDatabase,
): Set<string> {
  const db = getSessionKysely(database.db);
  const table = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("sqlite_schema")
      .select("name")
      .where("type", "=", "table")
      .where("name", "=", "session_transcript_archives"),
  ).rows[0];
  if (!table) {
    return new Set();
  }
  return new Set(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select("archive_name")
        .where("published_at", "is", null),
    ).rows.map((row) => row.archive_name),
  );
}

async function pruneCanonicalSessionTranscriptArchivesToHighWater(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  highWaterBytes: number;
  storePath: string;
}): Promise<{ removedFiles: number; usage: SessionPhysicalDiskUsage }> {
  let usage = await measureSessionPhysicalDiskUsage(params.storePath);
  let removedFiles = 0;
  while (usage.totalBytes > params.highWaterBytes) {
    const db = getSessionKysely(params.database.db);
    const row = executeSqliteQuerySync(
      params.database.db,
      db
        .selectFrom("session_transcript_archives")
        .select(["archive_name", "generation", "session_id"])
        .where("published_at", "is not", null)
        .orderBy("created_at", "asc")
        .orderBy("session_id", "asc")
        .orderBy("generation", "asc")
        .limit(1),
    ).rows[0];
    if (!row) {
      break;
    }
    const archivePath = path.resolve(params.archiveDirectory, row.archive_name);
    if (
      path.dirname(archivePath) !== path.resolve(params.archiveDirectory) ||
      path.basename(archivePath) !== row.archive_name
    ) {
      throw new Error(`Invalid canonical session archive name for ${row.session_id}`);
    }
    try {
      await fs.promises.rm(archivePath);
      removedFiles += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // The database is the recovery copy. Retain it unless its derived file
        // is gone, otherwise retention could leave an undeletable orphan.
        break;
      }
    }
    runOpenClawAgentWriteTransaction(
      (transactionDb) => {
        const transactionKysely = getSessionKysely(transactionDb.db);
        executeSqliteQuerySync(
          transactionDb.db,
          transactionKysely
            .deleteFrom("session_transcript_archives")
            .where("session_id", "=", row.session_id)
            .where("generation", "=", row.generation),
        );
      },
      { agentId: params.database.agentId, path: params.database.path },
    );
    reclaimSqliteFreePages(params.database);
    usage = await measureSessionPhysicalDiskUsage(params.storePath);
  }
  return { removedFiles, usage };
}

async function pruneAllSessionTranscriptArchivesToHighWater(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  highWaterBytes: number;
  storePath: string;
}): Promise<{ removedFiles: number; usage: SessionPhysicalDiskUsage }> {
  let canonical = {
    removedFiles: 0,
    usage: await measureSessionPhysicalDiskUsage(params.storePath),
  };
  if (hasCanonicalSessionTranscriptArchives(params.database)) {
    canonical = await pruneCanonicalSessionTranscriptArchivesToHighWater(params);
  }
  if (canonical.usage.totalBytes <= params.highWaterBytes) {
    return canonical;
  }
  const legacy = await pruneSessionTranscriptArchivesToHighWater({
    excludeNames: readUnpublishedSessionTranscriptArchiveNames(params.database),
    highWaterBytes: params.highWaterBytes,
    storePath: params.storePath,
  });
  return {
    removedFiles: canonical.removedFiles + legacy.removedFiles,
    usage: legacy.usage,
  };
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
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(resolved);
  let usage: SessionPhysicalDiskUsage = await runExclusiveSqliteSessionWrite(resolved, async () => {
    reclaimSqliteFreePages(database);
    return await measureSessionPhysicalDiskUsage(params.storePath);
  });
  let removedEntries = 0;
  let removedFiles = 0;
  if (usage.totalBytes > highWaterBytes) {
    // Archive pruning shares the SQLite writer queue so a concurrent
    // reset/delete cannot race its archive file against the unlink pass.
    const archiveSweep = await runExclusiveSqliteSessionWrite(resolved, async () =>
      pruneAllSessionTranscriptArchivesToHighWater({
        archiveDirectory,
        database,
        highWaterBytes,
        storePath: params.storePath,
      }),
    );
    removedFiles = archiveSweep.removedFiles;
    usage = archiveSweep.usage;
  }
  const candidates = readHistoricalSessionIds({
    database,
    protectedSessionIds: collectInitialProtectedHistoricalSessionIds({
      database,
      preserveRecentMs: params.maintenance.preserveRecentMs,
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
      run: async () => {
        const plan = await runExclusiveSqliteSessionWrite(resolved, async () => {
          const protectedBeforeArchive = collectCandidateProtectedHistoricalSessionIds({
            database,
            preserveRecentMs: params.maintenance.preserveRecentMs,
            sessionId,
            storePath: params.storePath,
          });
          const candidate = planSessionStateDeleteIfUnreferenced({
            archiveDirectory,
            archiveTranscript: true,
            database,
            reason: "deleted",
            referencedSessionIds: protectedBeforeArchive,
            sessionId,
          });
          if (!candidate) {
            return null;
          }
          return candidate;
        });
        if (!plan) {
          return null;
        }
        // Extract-before-delete is the retention invariant. The lifecycle hold
        // fences admission while the store writer is released for archive I/O.
        const materialized = await materializeSessionStateDeletePlans([plan]);
        const committedArchives = await runExclusiveSqliteSessionWrite(resolved, async () => {
          let deleted = false;
          let archivedTranscripts: ReturnType<typeof deleteMaterializedSessionStatePlans> = [];
          runOpenClawAgentWriteTransaction((transactionDb) => {
            const protectedAtDelete = collectCandidateProtectedHistoricalSessionIds({
              database: transactionDb,
              preserveRecentMs: params.maintenance.preserveRecentMs,
              sessionId,
              storePath: params.storePath,
            });
            archivedTranscripts = deleteMaterializedSessionStatePlans(
              transactionDb,
              materialized,
              protectedAtDelete,
            );
            const db = getSessionKysely(transactionDb.db);
            deleted =
              executeSqliteQuerySync(
                transactionDb.db,
                db
                  .selectFrom("session_windows")
                  .select("session_id")
                  .where("session_id", "=", sessionId),
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
          return archivedTranscripts;
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
          database,
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
        database,
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
