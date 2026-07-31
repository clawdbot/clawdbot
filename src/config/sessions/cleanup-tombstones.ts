/**
 * Sweeps tombstoned cron-run session remnants from the agent SQLite store.
 *
 * When a cron run session is pruned while its transcript windows survive,
 * deleteSqliteSessionEntryRows deliberately rewrites the session_nodes row as
 * a tombstone (entry_json without a sessionId) so the retained windows keep a
 * reference anchor. With archive retention unset those anchors — and the
 * transcript state under them — live forever, invisible to every runtime read
 * (parseSqliteSessionEntryJson rejects them), unbrowsable, and unboundedly
 * accumulating on cron-heavy agents (observed live: 1,733 tombstones anchoring
 * 19,206 dead transcript events, 60% of one agent's transcript table).
 *
 * Cron run transcripts are transient automation artifacts: after the age gate
 * they are deleted, not archived — archiving would only convert row debris
 * into file debris.
 */

import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { materializeSqliteSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import {
  deleteMaterializedSqliteSessionStatePlans,
  planSqliteSessionStateDeleteIfUnreferenced,
  readReferencedSqliteSessionIds,
  readSqliteSessionGenerationIdsForKeys,
} from "./session-accessor.sqlite-lifecycle-state.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptArchiveDirectory,
} from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryJson } from "./session-accessor.sqlite-status.js";

export type SessionTombstoneSweepResult = {
  /** Tombstoned cron-run rows past the age gate at scan time. */
  candidates: number;
  /** Node rows deleted (0 on dry runs). */
  removedNodes: number;
  /** Transcript session-state generations planned for deletion with them. */
  sweptTranscriptStates: number;
  olderThanMs: number;
};

type SessionNodeDatabase = Pick<Parameters<typeof readReferencedSqliteSessionIds>[0], "db">;

function listTombstonedCronRunKeys(database: SessionNodeDatabase, cutoffMs: number): string[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["session_key", "entry_json", "updated_at"]),
  ).rows;
  return rows
    .filter(
      (row) =>
        isCronRunSessionKey(row.session_key) &&
        row.updated_at < cutoffMs &&
        parseSqliteSessionEntryJson(row) === null,
    )
    .map((row) => row.session_key);
}

/** Removes aged cron-run tombstone rows plus the transcript state they anchor. */
export async function sweepTombstonedCronRunRemnants(params: {
  agentId: string;
  sqlitePath: string;
  olderThanMs: number;
  dryRun: boolean;
  nowMs?: number;
}): Promise<SessionTombstoneSweepResult> {
  const nowMs = params.nowMs ?? Date.now();
  const cutoffMs = nowMs - Math.max(params.olderThanMs, 0);
  const scope = { agentId: params.agentId, path: params.sqlitePath };
  const empty: SessionTombstoneSweepResult = {
    candidates: 0,
    removedNodes: 0,
    sweptTranscriptStates: 0,
    olderThanMs: params.olderThanMs,
  };

  if (params.dryRun) {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => listTombstonedCronRunKeys(database, cutoffMs).length,
      scope,
    );
    return result.found ? { ...empty, candidates: result.value } : empty;
  }

  // Plan, materialize, and delete are all synchronous, so the whole sweep
  // runs inside one write transaction: the scan, the reference projection,
  // and the deletes see one consistent snapshot — no revalidation dance.
  let removedNodes = 0;
  let candidates = 0;
  let sweptTranscriptStates = 0;
  runOpenClawAgentWriteTransaction(
    (database) => {
      const keys = listTombstonedCronRunKeys(database, cutoffMs);
      candidates = keys.length;
      if (keys.length === 0) {
        return;
      }
      const excluded = new Set(keys);
      const referencedSessionIds = readReferencedSqliteSessionIds(database, excluded);
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(scope);
      const plans = readSqliteSessionGenerationIdsForKeys(database, keys).flatMap((sessionId) => {
        const plan = planSqliteSessionStateDeleteIfUnreferenced({
          // Transient automation debris: delete, don't archive (see module doc).
          archiveTranscript: false,
          archiveDirectory,
          database,
          reason: "deleted",
          referencedSessionIds,
          sessionId,
        });
        return plan ? [plan] : [];
      });
      const materialized = materializeSqliteSessionStateDeletePlans(plans);
      deleteMaterializedSqliteSessionStatePlans(database, materialized, undefined, excluded);
      sweptTranscriptStates = materialized.length;
      const db = getSessionKysely(database.db);
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("session_windows").where("session_key", "in", keys),
      );
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("session_nodes").where("session_key", "in", keys),
      );
      removedNodes = keys.length;
    },
    scope,
    { operationLabel: "sessions.cleanup.tombstoned-cron-run-remnants" },
  );
  return {
    candidates,
    removedNodes,
    sweptTranscriptStates,
    olderThanMs: params.olderThanMs,
  };
}
