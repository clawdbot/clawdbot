import fs from "node:fs";
/**
 * Reclaims expired cron-run retained-history placeholders.
 *
 * Eligibility follows `cron.sessionRetention`. Transcript state is archived
 * before deletion; archive lifetime remains owned by existing archive policy.
 */

import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  deleteMaterializedSessionStatePlans,
  planSessionStateDeleteIfUnreferenced,
  readReferencedSessionIds,
} from "./session-accessor.sqlite-lifecycle-state.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { isCanonicalSqliteRetainedHistoryPlaceholder } from "./session-canonical-key.js";
import { collectAdmissionProtectedSessionIds } from "./session-history-eviction.js";

export type SessionTombstoneSweepResult = {
  /** Canonical expired cron-run placeholders at scan time. */
  candidates: number;
  /**
   * Subset of `candidates` admitted only because
   * `includeUnidentifiedPlaceholders` was set — aged cron-run rows whose entry
   * identity does not parse at all. Always 0 with the flag off. Surfaced so an
   * operator can see exactly how much of a sweep came from the widened path.
   */
  unidentifiedCandidates: number;
  /** Node rows deleted (0 on dry runs). */
  removedNodes: number;
  /** Transcript generations deleted after durable extraction. */
  sweptTranscriptStates: number;
  olderThanMs: number;
};

type TombstoneCandidate = {
  currentSessionId: string;
  generationIds: string[];
  sessionKey: string;
  updatedAt: number;
  /**
   * False when the row only qualified because the canonical-placeholder gate
   * was waived. Derived, so it deliberately stays out of `sameCandidate`.
   */
  identified: boolean;
};

/**
 * Lists expired cron-run placeholder rows.
 *
 * `includeUnidentified` additionally admits aged cron-run rows whose entry
 * identity does not parse. The cron-run key and age gates always apply, and
 * a row whose entry parses is never admitted by the waiver, so live sessions,
 * non-cron rows, and anything inside the retention window stay untouched
 * either way.
 */
function listCanonicalCronRunTombstones(
  database: Pick<OpenClawAgentDatabase, "db">,
  cutoffMs: number,
  includeUnidentified = false,
): TombstoneCandidate[] {
  const db = getSessionKysely(database.db);
  const nodes = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .leftJoin("session_windows as retained_window", (join) =>
        join
          .onRef("retained_window.session_id", "=", "session_nodes.current_session_id")
          .onRef("retained_window.session_key", "=", "session_nodes.session_key"),
      )
      .select([
        "session_nodes.session_key",
        "session_nodes.current_session_id",
        "session_nodes.entry_json",
        "session_nodes.entry_valid",
        "session_nodes.updated_at",
        "retained_window.session_id as retained_window_id",
      ]),
  ).rows;
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select(["session_id", "session_key", "updated_at"]),
  ).rows;
  const windowsByKey = new Map<string, Array<{ sessionId: string; updatedAt: number }>>();
  for (const window of windows) {
    const owned = windowsByKey.get(window.session_key) ?? [];
    owned.push({ sessionId: window.session_id, updatedAt: window.updated_at });
    windowsByKey.set(window.session_key, owned);
  }
  return nodes.flatMap((node) => {
    const ownedWindows = windowsByKey.get(node.session_key) ?? [];
    const updatedAt = Math.max(node.updated_at, ...ownedWindows.map((window) => window.updatedAt));
    if (!isCronRunSessionKey(node.session_key) || updatedAt >= cutoffMs) {
      return [];
    }
    const identified = isCanonicalSqliteRetainedHistoryPlaceholder(node);
    // The opt-in waives the canonical-shape gate but NOT liveness: a row only
    // qualifies when its entry identity fails to parse at all. An old-but-live
    // cron run parses fine and is never a candidate, however far past the gate
    // it is.
    if (!identified && !(includeUnidentified && parseSessionEntryJson(node) === null)) {
      return [];
    }
    return [
      {
        currentSessionId: node.current_session_id,
        generationIds: ownedWindows.map((window) => window.sessionId).toSorted(),
        sessionKey: node.session_key,
        updatedAt,
        identified,
      },
    ];
  });
}

function countUnidentified(candidates: TombstoneCandidate[]): number {
  return candidates.filter((candidate) => !candidate.identified).length;
}

function sameCandidate(left: TombstoneCandidate, right: TombstoneCandidate | undefined): boolean {
  return (
    right !== undefined &&
    left.currentSessionId === right.currentSessionId &&
    left.sessionKey === right.sessionKey &&
    left.updatedAt === right.updatedAt &&
    left.generationIds.length === right.generationIds.length &&
    left.generationIds.every((sessionId, index) => sessionId === right.generationIds[index])
  );
}

function readProtectedSessionIds(params: {
  candidate: TombstoneCandidate;
  database: OpenClawAgentDatabase;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = readReferencedSessionIds(
    params.database,
    new Set([params.candidate.sessionKey]),
  );
  for (const sessionId of collectAdmissionProtectedSessionIds({
    database: params.database,
    storePath: params.storePath,
  })) {
    protectedSessionIds.add(sessionId);
  }
  return protectedSessionIds;
}

/**
 * Archives and removes expired canonical cron-run placeholders and their
 * unshared state.
 *
 * `includeUnidentifiedPlaceholders` additionally reaps aged cron-run rows whose
 * entry identity fails to parse — debris the canonical gate cannot recognize.
 * Off by default: refusing to delete rows we cannot positively identify is the
 * safe posture, and a parser change would otherwise silently widen what gets
 * destroyed. A row whose entry parses is never admitted, so an old-but-live
 * cron run stays safe with the flag on. Read `unidentifiedCandidates` in the
 * dry run before applying.
 */
export async function sweepTombstonedCronRunRemnants(params: {
  agentId: string;
  storePath: string;
  sqlitePath: string;
  olderThanMs: number;
  dryRun: boolean;
  includeUnidentifiedPlaceholders?: boolean;
  nowMs?: number;
}): Promise<SessionTombstoneSweepResult> {
  const nowMs = params.nowMs ?? Date.now();
  const olderThanMs = Math.max(params.olderThanMs, 0);
  const cutoffMs = nowMs - olderThanMs;
  const includeUnidentified = params.includeUnidentifiedPlaceholders === true;
  const scope = { agentId: params.agentId, path: params.sqlitePath };
  const empty: SessionTombstoneSweepResult = {
    candidates: 0,
    unidentifiedCandidates: 0,
    removedNodes: 0,
    sweptTranscriptStates: 0,
    olderThanMs,
  };
  const scanned = withOpenClawAgentDatabaseReadOnly(
    (database) => listCanonicalCronRunTombstones(database, cutoffMs, includeUnidentified),
    scope,
  );
  const candidates = scanned.found ? scanned.value : [];
  if (params.dryRun || candidates.length === 0) {
    return {
      ...empty,
      candidates: candidates.length,
      unidentifiedCandidates: countUnidentified(candidates),
    };
  }

  let removedNodes = 0;
  let sweptTranscriptStates = 0;
  for (const candidate of candidates) {
    const result = await runExclusiveSessionLifecycleMutation({
      scope: params.storePath,
      identities: [candidate.sessionKey, ...candidate.generationIds],
      run: async () =>
        await runExclusiveSqliteSessionWrite(scope, async () => {
          const database = openOpenClawAgentDatabase(toDatabaseOptions(scope));
          const authoritative = listCanonicalCronRunTombstones(
            database,
            cutoffMs,
            includeUnidentified,
          ).find((current) => current.sessionKey === candidate.sessionKey);
          if (!sameCandidate(candidate, authoritative)) {
            return null;
          }
          const protectedSessionIds = readProtectedSessionIds({
            candidate,
            database,
            storePath: params.storePath,
          });
          if (candidate.generationIds.some((sessionId) => protectedSessionIds.has(sessionId))) {
            return null;
          }
          const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(scope);
          const plans = candidate.generationIds.flatMap((sessionId) => {
            const plan = planSessionStateDeleteIfUnreferenced({
              archiveDirectory,
              archiveTranscript: true,
              database,
              reason: "deleted",
              referencedSessionIds: protectedSessionIds,
              sessionId,
            });
            return plan ? [plan] : [];
          });
          if (plans.length !== candidate.generationIds.length) {
            return null;
          }
          const materialized = await materializeSessionStateDeletePlans(plans);
          let archivedTranscripts: ReturnType<typeof deleteMaterializedSessionStatePlans> = [];
          let removed = false;
          runOpenClawAgentWriteTransaction(
            (transactionDb) => {
              const current = listCanonicalCronRunTombstones(
                transactionDb,
                cutoffMs,
                includeUnidentified,
              ).find((entry) => entry.sessionKey === candidate.sessionKey);
              if (!sameCandidate(candidate, current)) {
                return;
              }
              const protectedAtDelete = readProtectedSessionIds({
                candidate,
                database: transactionDb,
                storePath: params.storePath,
              });
              if (candidate.generationIds.some((sessionId) => protectedAtDelete.has(sessionId))) {
                return;
              }
              archivedTranscripts = deleteMaterializedSessionStatePlans(
                transactionDb,
                materialized,
                protectedAtDelete,
                new Set([candidate.sessionKey]),
              );
              const db = getSessionKysely(transactionDb.db);
              const remainingGenerationIds = executeSqliteQuerySync(
                transactionDb.db,
                db
                  .selectFrom("session_windows")
                  .select("session_id")
                  .where("session_key", "=", candidate.sessionKey),
              ).rows;
              if (remainingGenerationIds.length > 0) {
                return;
              }
              deleteSessionEntryRows(transactionDb, candidate.sessionKey);
              removed =
                executeSqliteQuerySync(
                  transactionDb.db,
                  db
                    .selectFrom("session_nodes")
                    .select("session_key")
                    .where("session_key", "=", candidate.sessionKey),
                ).rows.length === 0;
            },
            scope,
            { operationLabel: "sessions.cleanup.tombstoned-cron-run-remnants" },
          );
          if (!removed) {
            return null;
          }
          return {
            archivedTranscripts,
            sweptTranscriptStates: candidate.generationIds.length,
          };
        }),
    });
    if (!result) {
      continue;
    }
    removedNodes += 1;
    sweptTranscriptStates += result.sweptTranscriptStates;
    emitArchivedTranscriptUpdates(result.archivedTranscripts);
  }
  return {
    candidates: candidates.length,
    unidentifiedCandidates: countUnidentified(candidates),
    removedNodes,
    sweptTranscriptStates,
    olderThanMs,
  };
}

/**
 * Resolves the cron-run tombstone sweep for one store, or null when retention
 * is disabled or the store has no SQLite file yet. Lives here rather than in
 * cleanup-service so the preview and apply paths share one definition.
 */
export async function sweepTombstonedCronRunRemnantsForStore(params: {
  agentId: string;
  storePath: string;
  sqlitePath: string;
  retentionMs: number | null;
  dryRun: boolean;
  includeUnidentifiedPlaceholders?: boolean;
}): Promise<SessionTombstoneSweepResult | null> {
  if (params.retentionMs == null || !fs.existsSync(params.sqlitePath)) {
    return null;
  }
  return await sweepTombstonedCronRunRemnants({
    agentId: params.agentId,
    storePath: params.storePath,
    sqlitePath: params.sqlitePath,
    olderThanMs: params.retentionMs,
    dryRun: params.dryRun,
    includeUnidentifiedPlaceholders: params.includeUnidentifiedPlaceholders === true,
  });
}
