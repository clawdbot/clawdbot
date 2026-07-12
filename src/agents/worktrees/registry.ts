import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { isLockOwnerDefinitelyStale } from "../../infra/stale-lock-file.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import type { ManagedWorktreeOwnerKind, ManagedWorktreeRecord } from "./types.js";

type WorktreesTable = OpenClawStateKyselyDatabase["worktrees"];
type WorktreeRow = Selectable<WorktreesTable>;
type WorktreeRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "worktrees">;
type WorktreeLeaseDatabase = Pick<OpenClawStateKyselyDatabase, "worktrees" | "state_leases">;

function dbFor(env: NodeJS.ProcessEnv): DatabaseSync {
  return openOpenClawStateDatabase({ env }).db;
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorktreeRegistryDatabase>(db);
}

function kyselyLeaseFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorktreeLeaseDatabase>(db);
}

function rowToRecord(row: WorktreeRow): ManagedWorktreeRecord {
  return {
    id: row.id,
    name: row.path.split(/[\\/]/).at(-1) ?? row.id,
    repoFingerprint: row.repo_fingerprint,
    repoRoot: row.repo_root,
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    ownerKind: row.owner_kind as ManagedWorktreeOwnerKind,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(row.snapshot_ref ? { snapshotRef: row.snapshot_ref } : {}),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    ...(row.removed_at == null ? {} : { removedAt: row.removed_at }),
  };
}

function recordToRow(record: ManagedWorktreeRecord): Insertable<WorktreesTable> {
  return {
    id: record.id,
    repo_fingerprint: record.repoFingerprint,
    repo_root: record.repoRoot,
    path: record.path,
    branch: record.branch,
    base_ref: record.baseRef,
    owner_kind: record.ownerKind,
    owner_id: record.ownerId ?? null,
    snapshot_ref: record.snapshotRef ?? null,
    created_at: record.createdAt,
    last_active_at: record.lastActiveAt,
    removed_at: record.removedAt ?? null,
  };
}

export function listRegistryWorktrees(env: NodeJS.ProcessEnv): ManagedWorktreeRecord[] {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .selectAll()
    .orderBy("created_at", "desc")
    .orderBy("id", "asc");
  return executeSqliteQuerySync(db, query).rows.map(rowToRecord);
}

export function getRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db).selectFrom("worktrees").selectAll().where("id", "=", id);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function findLiveRegistryWorktreeByPath(
  env: NodeJS.ProcessEnv,
  worktreePath: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .selectAll()
    .where("path", "=", worktreePath)
    .where("removed_at", "is", null)
    .orderBy("created_at", "desc")
    .limit(1);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function findLiveRegistryWorktreeByOwner(
  env: NodeJS.ProcessEnv,
  ownerKind: ManagedWorktreeOwnerKind,
  ownerId: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .selectAll()
    .where("owner_kind", "=", ownerKind)
    .where("owner_id", "=", ownerId)
    .where("removed_at", "is", null)
    .orderBy("created_at", "desc")
    .limit(1);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function findRegistryWorktreeByPath(
  env: NodeJS.ProcessEnv,
  worktreePath: string,
): ManagedWorktreeRecord | undefined {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("worktrees")
    .selectAll()
    .where("path", "=", worktreePath)
    .orderBy("created_at", "desc")
    .limit(1);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function insertRegistryWorktree(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
): void {
  const db = dbFor(env);
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(db, kyselyFor(db).insertInto("worktrees").values(recordToRow(record)));
  });
}

export function updateRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
  patch: Partial<Pick<ManagedWorktreeRecord, "lastActiveAt" | "removedAt" | "snapshotRef">>,
): void {
  const db = dbFor(env);
  const values: Partial<WorktreeRow> = {};
  if (patch.lastActiveAt !== undefined) {
    values.last_active_at = patch.lastActiveAt;
  }
  if ("removedAt" in patch) {
    values.removed_at = patch.removedAt ?? null;
  }
  if ("snapshotRef" in patch) {
    values.snapshot_ref = patch.snapshotRef ?? null;
  }
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(
      db,
      kyselyFor(db).updateTable("worktrees").set(values).where("id", "=", id),
    );
  });
}

export function deleteRegistryWorktree(env: NodeJS.ProcessEnv, id: string): void {
  const db = dbFor(env);
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(db, kyselyFor(db).deleteFrom("worktrees").where("id", "=", id));
  });
}

const WORKTREE_RUN_LEASE_SCOPE_PREFIX = "worktree-run:";
const WORKTREE_REMOVING_LEASE_KEY = "__removing__";

export type RunLeaseOwnerChecks = {
  isPidDefinitelyDead?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => number | null;
};

function worktreeRunLeaseScope(worktreeId: string): string {
  return `${WORKTREE_RUN_LEASE_SCOPE_PREFIX}${worktreeId}`;
}

function parseLeaseOwnerPayload(payloadJson: string | null): { pid?: number; starttime?: number } {
  if (!payloadJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      starttime: typeof parsed.starttime === "number" ? parsed.starttime : undefined,
    };
  } catch {
    return {};
  }
}

type ScopeLeaseState = { livePids: number[]; removingToken?: string };

function collectLiveRunLeases(
  db: DatabaseSync,
  k: ReturnType<typeof kyselyLeaseFor>,
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
  }
  if (staleKeys.length > 0) {
    executeSqliteQuerySync(
      db,
      k.deleteFrom("state_leases").where("scope", "=", scope).where("lease_key", "in", staleKeys),
    );
  }
  return { livePids, ...(removingToken !== undefined ? { removingToken } : {}) };
}

export function admitWorktreeRunLeaseRow(
  env: NodeJS.ProcessEnv,
  params: {
    worktreeId: string;
    token: string;
    pid: number;
    startTime: number | null;
    now: number;
    checks?: RunLeaseOwnerChecks;
  },
): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = database.db;
      const k = kyselyLeaseFor(db);
      const scope = worktreeRunLeaseScope(params.worktreeId);
      const record = executeSqliteQuerySync(
        db,
        k
          .selectFrom("worktrees")
          .select(["path", "removed_at"])
          .where("id", "=", params.worktreeId),
      ).rows[0];
      const worktreePath = record?.path ?? params.worktreeId;
      if (!record || record.removed_at != null) {
        throw new Error(`managed worktree was removed: ${worktreePath}`);
      }
      const { removingToken } = collectLiveRunLeases(db, k, scope, params.checks ?? {});
      if (removingToken !== undefined) {
        throw new Error(`managed worktree was removed: ${worktreePath}`);
      }
      executeSqliteQuerySync(
        db,
        k.insertInto("state_leases").values({
          scope,
          lease_key: params.token,
          owner: `${params.pid}:${params.startTime ?? ""}`,
          expires_at: null,
          heartbeat_at: null,
          payload_json: JSON.stringify({
            pid: params.pid,
            starttime: params.startTime ?? undefined,
          }),
          created_at: params.now,
          updated_at: params.now,
        }),
      );
    },
    { env },
  );
}

export function claimWorktreeRemovalRow(
  env: NodeJS.ProcessEnv,
  params: {
    worktreeId: string;
    token: string;
    force: boolean;
    pid: number;
    startTime: number | null;
    now: number;
    checks?: RunLeaseOwnerChecks;
  },
): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = database.db;
      const k = kyselyLeaseFor(db);
      const scope = worktreeRunLeaseScope(params.worktreeId);
      const { livePids, removingToken } = collectLiveRunLeases(db, k, scope, params.checks ?? {});
      if (!params.force && livePids.length > 0) {
        throw new Error(`worktree is busy: locked by live pid ${livePids[0]}`);
      }
      // The removal claim is exclusive: a live marker owned by a different token means
      // another remover is mid-operation, so this remover must not enter it too.
      if (removingToken !== undefined && removingToken !== params.token) {
        throw new Error("worktree removal is already in progress");
      }
      const payloadJson = JSON.stringify({
        pid: params.pid,
        starttime: params.startTime ?? undefined,
      });
      executeSqliteQuerySync(
        db,
        k
          .insertInto("state_leases")
          .values({
            scope,
            lease_key: WORKTREE_REMOVING_LEASE_KEY,
            owner: params.token,
            expires_at: null,
            heartbeat_at: null,
            payload_json: payloadJson,
            created_at: params.now,
            updated_at: params.now,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope", "lease_key"]).doUpdateSet({
              owner: params.token,
              payload_json: payloadJson,
              updated_at: params.now,
            }),
          ),
      );
    },
    { env },
  );
}

export function releaseWorktreeRunLeaseRow(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
): void {
  const db = dbFor(env);
  runOpenClawStateWriteTransaction(
    () => {
      executeSqliteQuerySync(
        db,
        kyselyLeaseFor(db)
          .deleteFrom("state_leases")
          .where("scope", "=", worktreeRunLeaseScope(worktreeId))
          .where("lease_key", "=", token),
      );
    },
    { env },
  );
}

export function finalizeWorktreeRemovalRows(env: NodeJS.ProcessEnv, worktreeId: string): void {
  const db = dbFor(env);
  runOpenClawStateWriteTransaction(
    () => {
      executeSqliteQuerySync(
        db,
        kyselyLeaseFor(db)
          .deleteFrom("state_leases")
          .where("scope", "=", worktreeRunLeaseScope(worktreeId)),
      );
    },
    { env },
  );
}

export function abortWorktreeRemovalRow(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
): void {
  const db = dbFor(env);
  runOpenClawStateWriteTransaction(
    () => {
      // Owner-scoped: only the claim that still owns the marker may clear it, so a slow
      // remover cannot delete a marker a newer remover established after replacing it.
      executeSqliteQuerySync(
        db,
        kyselyLeaseFor(db)
          .deleteFrom("state_leases")
          .where("scope", "=", worktreeRunLeaseScope(worktreeId))
          .where("lease_key", "=", WORKTREE_REMOVING_LEASE_KEY)
          .where("owner", "=", token),
      );
    },
    { env },
  );
}

export function hasLiveWorktreeRunLeaseRow(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  checks?: RunLeaseOwnerChecks,
): boolean {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = database.db;
      const k = kyselyLeaseFor(db);
      const { livePids } = collectLiveRunLeases(
        db,
        k,
        worktreeRunLeaseScope(worktreeId),
        checks ?? {},
      );
      return livePids.length > 0;
    },
    { env },
  );
}
