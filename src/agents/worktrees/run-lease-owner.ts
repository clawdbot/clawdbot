import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, type getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { isLockOwnerDefinitelyStale } from "../../infra/stale-lock-file.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

type WorktreeLeaseDatabase = Pick<DB, "worktrees" | "state_leases">;
export const WORKTREE_REMOVING_LEASE_KEY = "__removing__";

export type RunLeaseOwnerChecks = {
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
};

function parseLeaseOwnerPayload(payloadJson: string | null): {
  pid?: number;
  starttime?: number;
  exclusive?: true;
} {
  if (!payloadJson) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      starttime: typeof parsed.starttime === "number" ? parsed.starttime : undefined,
      ...(parsed.exclusive === true ? { exclusive: true } : {}),
    };
  } catch {
    return {};
  }
}

type ScopeLeaseState = {
  livePids: number[];
  liveCount: number;
  exclusive: boolean;
  removingToken?: string;
};

export function collectLiveRunLeases(
  db: DatabaseSync,
  k: ReturnType<typeof getNodeSqliteKysely<WorktreeLeaseDatabase>>,
  scope: string,
  checks: RunLeaseOwnerChecks,
): ScopeLeaseState {
  const rows = executeSqliteQuerySync(
    db,
    k
      .selectFrom("state_leases")
      .select(["lease_key", "owner", "payload_json"])
      .where("scope", "=", scope),
  ).rows;
  const livePids: number[] = [];
  const staleKeys: string[] = [];
  let removingToken: string | undefined;
  let liveCount = 0;
  let exclusive = false;
  for (const row of rows) {
    const payload = parseLeaseOwnerPayload(row.payload_json);
    const stale = isLockOwnerDefinitelyStale({
      payload,
      isPidDefinitelyDead: checks.isPidDefinitelyDead,
      getProcessStartTime: checks.getProcessStartTime,
    });
    if (row.lease_key === WORKTREE_REMOVING_LEASE_KEY) {
      // A removal marker whose remover process died before finalize must self-heal,
      // otherwise a still-live worktree stays permanently unadmittable. A live marker
      // carries the owning claim token so a competing remover is rejected.
      if (stale) {
        staleKeys.push(row.lease_key);
      } else {
        removingToken = row.owner;
      }
      continue;
    }
    if (stale) {
      staleKeys.push(row.lease_key);
      continue;
    }
    if (payload.pid !== undefined) {
      livePids.push(payload.pid);
    }
    liveCount += 1;
    exclusive ||= payload.exclusive === true;
  }
  if (staleKeys.length > 0) {
    executeSqliteQuerySync(
      db,
      k.deleteFrom("state_leases").where("scope", "=", scope).where("lease_key", "in", staleKeys),
    );
  }
  return {
    livePids,
    liveCount,
    exclusive,
    ...(removingToken !== undefined ? { removingToken } : {}),
  };
}
