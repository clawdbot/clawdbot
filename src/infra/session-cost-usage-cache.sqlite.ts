import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
// Per-agent SQLite storage for rebuildable per-session usage rollups.
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { isTransientSqliteError } from "./unhandled-rejections.js";

const LEGACY_CACHE_SCOPE = "session-cost-usage";
const RETIRED_ROLLUP_SCOPE = "session-cost-usage-rollup-v1";
const ROLLUP_SCOPE = "session-cost-usage-rollup-v2";

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries" | "state_leases">;

export const SESSION_COST_USAGE_REFRESH_LEASE_OPTIONS = {
  scope: "session-cost-usage",
  key: "refresh",
  leaseMs: 60_000,
  waitMs: 0,
  leaseLabel: "session cost usage refresh lease",
  operationLabel: "session-cost-usage.refresh.lease",
} as const;

export type SessionCostUsageRefreshLeaseOwner = Pick<
  OpenClawStateLeaseContext,
  "assertOwnedInTransaction"
>;

type SessionCostUsageRollupRow = {
  key: string;
  updatedAt: number;
  valueJson: string;
};

function readCacheDatabase<T>(
  agentId: string | undefined,
  databasePath: string | undefined,
  operation: (database: { db: DatabaseSync }) => T,
): T | undefined {
  try {
    const result = withOpenClawAgentDatabaseReadOnly(operation, {
      agentId: normalizeAgentId(agentId),
      ...(databasePath ? { path: databasePath } : {}),
    });
    return result.found ? result.value : undefined;
  } catch (error) {
    if (!isTransientSqliteError(error)) {
      throw error;
    }
    // Usage rollups are rebuildable cache; stale or empty data beats failing the dashboard.
    return undefined;
  }
}

export function readSessionCostUsageRollupRows(
  agentId?: string,
  databasePath?: string,
): SessionCostUsageRollupRow[] {
  return (
    readCacheDatabase(agentId, databasePath, (database) => {
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
    }) ?? []
  );
}

export function writeSessionCostUsageRollup(params: {
  agentId?: string;
  databasePath?: string;
  leaseOwner: SessionCostUsageRefreshLeaseOwner;
  rollupId: string;
  previousValueJson: string | null;
  valueJson: string;
  updatedAt: number;
}): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      params.leaseOwner.assertOwnedInTransaction(database.db);
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
  leaseOwner: SessionCostUsageRefreshLeaseOwner;
  liveKeys: ReadonlySet<string>;
  rows: readonly SessionCostUsageRollupRow[];
}): void {
  const existing = params.rows.filter((row) => !params.liveKeys.has(row.key));
  runOpenClawAgentWriteTransaction(
    (database) => {
      params.leaseOwner.assertOwnedInTransaction(database.db);
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      for (const row of existing) {
        executeSqliteQuerySync(
          database.db,
          kysely
            .deleteFrom("cache_entries")
            .where("scope", "=", ROLLUP_SCOPE)
            .where("key", "=", row.key)
            .where("value_json", "=", row.valueJson)
            .where("updated_at", "=", row.updatedAt),
        );
      }
      deleteRetiredSessionCostUsageCacheEntriesInTransaction(database.db);
    },
    {
      agentId: normalizeAgentId(params.agentId),
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.rollup.prune" },
  );
}

export function isSessionCostUsageRefreshRunning(agentId?: string, databasePath?: string): boolean {
  return (
    readCacheDatabase(agentId, databasePath, (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      return (
        executeSqliteQuerySync(
          database.db,
          kysely
            .selectFrom("state_leases")
            .select("owner")
            .where("scope", "=", SESSION_COST_USAGE_REFRESH_LEASE_OPTIONS.scope)
            .where("lease_key", "=", SESSION_COST_USAGE_REFRESH_LEASE_OPTIONS.key)
            .where("expires_at", ">", Date.now())
            .limit(1),
        ).rows[0] !== undefined
      );
    }) ?? false
  );
}

function deleteRetiredSessionCostUsageCacheEntriesInTransaction(database: DatabaseSync): void {
  const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database);
  executeSqliteQuerySync(
    database,
    kysely.deleteFrom("cache_entries").where("scope", "=", LEGACY_CACHE_SCOPE),
  );
  // v1 duplicated a multi-megabyte pricing catalog per row (#115282).
  // Delete by scope so those values are never materialized during cleanup.
  executeSqliteQuerySync(
    database,
    kysely.deleteFrom("cache_entries").where("scope", "=", RETIRED_ROLLUP_SCOPE),
  );
}

export function deleteRetiredSessionCostUsageCacheEntries(params: {
  agentId?: string;
  databasePath?: string;
}): void {
  runOpenClawAgentWriteTransaction(
    (database) => deleteRetiredSessionCostUsageCacheEntriesInTransaction(database.db),
    {
      agentId: normalizeAgentId(params.agentId),
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.retired.delete" },
  );
}
