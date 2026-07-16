import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
// Per-agent SQLite storage for rebuildable per-session usage rollups.
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const LEGACY_CACHE_SCOPE = "session-cost-usage";
const LEGACY_CACHE_KEY = "cache";
const REFRESH_LOCK_KEY = "refresh-lock";
const ROLLUP_SCOPE = "session-cost-usage-rollup-v1";

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

type SessionCostUsageRefreshLock = {
  pid: number;
  startedAt: number;
  ownerNonce: string;
};

type SessionCostUsageRollupRow = {
  key: string;
  updatedAt: number;
  valueJson: string;
};

function openCacheDatabase(agentId: string | undefined, databasePath?: string) {
  return openOpenClawAgentDatabase({
    agentId: normalizeAgentId(agentId),
    ...(databasePath ? { path: databasePath } : {}),
  });
}

function readCacheValue(
  agentId: string | undefined,
  scope: string,
  key: string,
  databasePath?: string,
): string | null {
  const database = openCacheDatabase(agentId, databasePath);
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
  const row = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("cache_entries")
      .select("value_json")
      .where("scope", "=", scope)
      .where("key", "=", key)
      .limit(1),
  ).rows[0];
  return row?.value_json ?? null;
}

function deleteCacheValueIfUnchanged(params: {
  agentId?: string;
  databasePath?: string;
  scope: string;
  key: string;
  valueJson: string;
}): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", params.scope)
          .where("key", "=", params.key)
          .where("value_json", "=", params.valueJson),
      );
    },
    {
      agentId: normalizeAgentId(params.agentId),
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: `session-cost-usage.${params.key}.delete` },
  );
}

export function readSessionCostUsageRollupRows(
  agentId?: string,
  databasePath?: string,
): SessionCostUsageRollupRow[] {
  const database = openCacheDatabase(agentId, databasePath);
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("cache_entries")
      .select(["key", "value_json", "updated_at"])
      .where("scope", "=", ROLLUP_SCOPE),
  ).rows.flatMap((row) =>
    row.value_json === null
      ? []
      : [{ key: row.key, valueJson: row.value_json, updatedAt: row.updated_at }],
  );
}

export function writeSessionCostUsageRollup(params: {
  agentId?: string;
  databasePath?: string;
  rollupId: string;
  previousValueJson: string | null;
  valueJson: string;
  updatedAt: number;
}): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      const currentValueJson =
        executeSqliteQuerySync(
          database.db,
          kysely
            .selectFrom("cache_entries")
            .select("value_json")
            .where("scope", "=", ROLLUP_SCOPE)
            .where("key", "=", params.rollupId)
            .limit(1),
        ).rows[0]?.value_json ?? null;
      if (currentValueJson !== params.previousValueJson) {
        return false;
      }
      executeSqliteQuerySync(
        database.db,
        kysely
          .insertInto("cache_entries")
          .values({
            scope: ROLLUP_SCOPE,
            key: params.rollupId,
            value_json: params.valueJson,
            blob: null,
            expires_at: null,
            updated_at: params.updatedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope", "key"]).doUpdateSet({
              value_json: params.valueJson,
              blob: null,
              expires_at: null,
              updated_at: params.updatedAt,
            }),
          ),
      );
      return true;
    },
    {
      agentId: normalizeAgentId(params.agentId),
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.rollup.write" },
  );
}

export function deleteSessionCostUsageRollupsExcept(params: {
  agentId?: string;
  databasePath?: string;
  liveKeys: ReadonlySet<string>;
}): void {
  const existing = readSessionCostUsageRollupRows(params.agentId, params.databasePath)
    .map((row) => row.key)
    .filter((key) => !params.liveKeys.has(key));
  runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      for (const key of existing) {
        executeSqliteQuerySync(
          database.db,
          kysely
            .deleteFrom("cache_entries")
            .where("scope", "=", ROLLUP_SCOPE)
            .where("key", "=", key),
        );
      }
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", LEGACY_CACHE_SCOPE)
          .where("key", "=", LEGACY_CACHE_KEY),
      );
    },
    {
      agentId: normalizeAgentId(params.agentId),
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.rollup.prune" },
  );
}

function parseRefreshLock(raw: string | null): SessionCostUsageRefreshLock | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<SessionCostUsageRefreshLock> | null;
    if (
      !value ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.startedAt !== "number" ||
      !Number.isFinite(value.startedAt) ||
      typeof value.ownerNonce !== "string" ||
      !value.ownerNonce
    ) {
      return null;
    }
    return { pid: value.pid, startedAt: value.startedAt, ownerNonce: value.ownerNonce };
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isSessionCostUsageRefreshRunning(agentId?: string, databasePath?: string): boolean {
  const raw = readCacheValue(agentId, LEGACY_CACHE_SCOPE, REFRESH_LOCK_KEY, databasePath);
  const lock = parseRefreshLock(raw);
  if (lock && isProcessRunning(lock.pid)) {
    return true;
  }
  if (raw !== null) {
    deleteCacheValueIfUnchanged({
      agentId,
      databasePath,
      scope: LEGACY_CACHE_SCOPE,
      key: REFRESH_LOCK_KEY,
      valueJson: raw,
    });
  }
  return false;
}

export function acquireSessionCostUsageRefreshLock(
  agentId?: string,
  databasePath?: string,
): { acquired: boolean; release: () => void } {
  const previousRaw = readCacheValue(agentId, LEGACY_CACHE_SCOPE, REFRESH_LOCK_KEY, databasePath);
  const previousLock = parseRefreshLock(previousRaw);
  // Process liveness is resolved before BEGIN. The transaction only compares
  // the authoritative row and commits the prepared replacement synchronously.
  const previousOwnerIsRunning = previousLock ? isProcessRunning(previousLock.pid) : false;
  const lock: SessionCostUsageRefreshLock = {
    pid: process.pid,
    startedAt: Date.now(),
    ownerNonce: `${process.pid}:${Date.now()}:${process.hrtime.bigint()}`,
  };
  const lockJson = JSON.stringify(lock);
  const acquired = runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      const currentRaw =
        executeSqliteQuerySync(
          database.db,
          kysely
            .selectFrom("cache_entries")
            .select("value_json")
            .where("scope", "=", LEGACY_CACHE_SCOPE)
            .where("key", "=", REFRESH_LOCK_KEY)
            .limit(1),
        ).rows[0]?.value_json ?? null;
      if (currentRaw !== previousRaw || previousOwnerIsRunning) {
        return false;
      }
      executeSqliteQuerySync(
        database.db,
        kysely
          .insertInto("cache_entries")
          .values({
            scope: LEGACY_CACHE_SCOPE,
            key: REFRESH_LOCK_KEY,
            value_json: lockJson,
            blob: null,
            expires_at: null,
            updated_at: lock.startedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope", "key"]).doUpdateSet({
              value_json: lockJson,
              blob: null,
              expires_at: null,
              updated_at: lock.startedAt,
            }),
          ),
      );
      return true;
    },
    {
      agentId: normalizeAgentId(agentId),
      ...(databasePath ? { path: databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.refresh-lock.acquire" },
  );
  return {
    acquired,
    release: () => {
      if (acquired) {
        deleteCacheValueIfUnchanged({
          agentId,
          databasePath,
          scope: LEGACY_CACHE_SCOPE,
          key: REFRESH_LOCK_KEY,
          valueJson: lockJson,
        });
      }
    },
  };
}
