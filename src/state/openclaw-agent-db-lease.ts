import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { hasErrnoCode } from "../infra/errno.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { ensureAgentDatabaseLeaseSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

type AgentDatabaseLeaseDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_database_leases" | "agent_deletion_journal" | "state_leases"
>;

export const AGENT_DATABASE_MAINTENANCE_LEASE = {
  scope: "core:agent-database-maintenance",
  key: "global",
} as const;

export class OpenClawAgentDatabaseLeaseActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenClawAgentDatabaseLeaseActiveError";
  }
}

const maintenanceAuthority = new AsyncLocalStorage<OpenClawStateLeaseContext>();

export function runWithAgentDatabaseMaintenanceAuthority<T>(
  authority: OpenClawStateLeaseContext,
  run: () => Promise<T>,
): Promise<T> {
  return maintenanceAuthority.run(authority, run);
}

/** Revalidate the held lease, including immediately before committing a versioned rebuild. */
export function assertAgentDatabaseMaintenanceAuthority(
  expected?: OpenClawStateLeaseContext,
): void {
  const authority = maintenanceAuthority.getStore();
  if (!authority || (expected && authority !== expected)) {
    throw new Error(
      "Agent identity migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.",
    );
  }
  authority.assertOwned();
}

/** Revalidate a maintenance owner when present, without requiring ordinary opens to hold one. */
export function assertAgentDatabaseMaintenanceAuthorityIfPresent(): void {
  maintenanceAuthority.getStore()?.assertOwned();
}

/** Verify the maintenance owner and its independent heartbeat before a synchronous phase. */
export function renewAgentDatabaseMaintenanceAuthorityIfPresent(): void {
  const authority = maintenanceAuthority.getStore();
  if (!authority) {
    return;
  }
  if (!authority.renew) {
    throw new Error("Agent database maintenance authority cannot renew its lease.");
  }
  authority.renew();
}

export function claimOpenClawAgentDatabaseLease(
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  leaseId: string = crypto.randomUUID(),
): string {
  const agentId = normalizeAgentId(params.agentId);
  const deletionFence = prepareAgentDeletionPathFence(
    { agentId, path: params.path },
    { env: params.env },
  );
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  runOpenClawStateWriteTransaction(
    (database) => {
      ensureAgentDatabaseLeaseSchema(database.db);
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
      const maintenance = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("state_leases")
          .select("owner")
          .where("scope", "=", AGENT_DATABASE_MAINTENANCE_LEASE.scope)
          .where("lease_key", "=", AGENT_DATABASE_MAINTENANCE_LEASE.key)
          .where("expires_at", ">", Date.now()),
      );
      if (maintenance) {
        throw new Error(
          "Agent database maintenance is in progress; retry after openclaw doctor --fix completes.",
        );
      }
      assertAgentDeletionPathFence(database, deletionFence);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("agent_database_leases").values({
          lease_id: leaseId,
          agent_id: agentId,
          path: params.path,
          owner_pid: process.pid,
          owner_start_time: ownerStartTime,
          opened_at: Date.now(),
        }),
      );
    },
    { env: params.env },
  );
  return leaseId;
}

export function releaseOpenClawAgentDatabaseLease(
  leaseId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDatabaseLeaseSchema(database.db);
    const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("agent_database_leases").where("lease_id", "=", leaseId),
    );
  }, options);
}

/** An awaited open may consume its scan only while its original runtime claim survives. */
export function assertOpenClawAgentDatabaseLease(
  leaseId: string,
  params: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
): void {
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  const database = openOpenClawStateDatabase({ env: params.env });
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
  const held = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("agent_database_leases")
      .select(["agent_id", "path", "owner_pid", "owner_start_time"])
      .where("lease_id", "=", leaseId),
  );
  if (
    !held ||
    held.agent_id !== params.agentId ||
    held.path !== params.path ||
    held.owner_pid !== process.pid ||
    // Claims allow an unavailable start identity; only two known identities prove reuse.
    (held.owner_start_time !== null &&
      ownerStartTime !== null &&
      held.owner_start_time !== ownerStartTime)
  ) {
    throw new Error(`Agent database open lost its runtime lease: ${params.path}`);
  }
}

function readAgentDatabaseLeases(database: DatabaseSync) {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("agent_database_leases")
      .select(["agent_id", "lease_id", "owner_pid", "owner_start_time", "path"]),
  ).rows;
}

function isAgentDatabaseLeaseStale(row: {
  owner_pid: number;
  owner_start_time: number | null;
}): boolean {
  if (isPidDefinitelyDead(row.owner_pid)) {
    return true;
  }
  const currentStartTime = getFileLockProcessStartTime(row.owner_pid);
  return (
    row.owner_start_time !== null &&
    currentStartTime !== null &&
    row.owner_start_time !== currentStartTime
  );
}

/** Doctor holds both lifecycle coordinators before checking writers, without schema repair. */
export function assertNoOpenClawAgentDatabaseLeasesReadOnly(
  options: OpenClawStateDatabaseOptions = {},
): void {
  const pathname = path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env));
  try {
    fs.statSync(pathname);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  // Admission must also work after restoring a quarantined database. Runtime
  // readers reject that receipt before Doctor can verify and clear it.
  const cached = openClawStateDatabaseCache.isOpenClawStateDatabaseOpen(pathname)
    ? openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(pathname)
    : undefined;
  const db = cached?.db ?? openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    runWithSqliteBusyTimeout(db, 250, () => {
      if (!tableExists(db, "agent_database_leases")) {
        return;
      }
      const owner = readAgentDatabaseLeases(db).find((row) => !isAgentDatabaseLeaseStale(row));
      if (owner) {
        throw new OpenClawAgentDatabaseLeaseActiveError(
          `Agent ${owner.agent_id} database is still open in process ${owner.owner_pid}; stop that process before Doctor repair.`,
        );
      }
    });
  } finally {
    if (!cached) {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    }
  }
}

export function assertNoOpenClawAgentDatabaseLeases(
  agentIdRaw: string | OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const maintenance = typeof agentIdRaw === "string" ? undefined : agentIdRaw;
  const agentId = typeof agentIdRaw === "string" ? normalizeAgentId(agentIdRaw) : undefined;
  const rows = runOpenClawStateWriteTransaction((database) => {
    maintenance?.assertOwnedInTransaction(database.db);
    ensureAgentDatabaseLeaseSchema(database.db);
    return readAgentDatabaseLeases(database.db);
  }, options);

  const staleLeaseIds = rows.filter(isAgentDatabaseLeaseStale).map((row) => row.lease_id);
  if (staleLeaseIds.length > 0) {
    runOpenClawStateWriteTransaction((database) => {
      maintenance?.assertOwnedInTransaction(database.db);
      ensureAgentDatabaseLeaseSchema(database.db);
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("agent_database_leases").where("lease_id", "in", staleLeaseIds),
      );
    }, options);
  }
  const staleLeaseIdSet = new Set(staleLeaseIds);
  for (const row of rows) {
    if (staleLeaseIdSet.has(row.lease_id)) {
      continue;
    }
    const deletionFence = agentId
      ? prepareAgentDeletionPathFence(
          { agentId: row.agent_id, path: row.path, fenceAgentId: agentId },
          options,
        )
      : undefined;
    let leaseStillExists = false;
    runOpenClawStateWriteTransaction((database) => {
      maintenance?.assertOwnedInTransaction(database.db);
      ensureAgentDatabaseLeaseSchema(database.db);
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
      leaseStillExists =
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("agent_database_leases")
            .select("lease_id")
            .where("lease_id", "=", row.lease_id),
        ) !== undefined;
      if (leaseStillExists && row.agent_id !== agentId && deletionFence) {
        assertAgentDeletionPathFence(database, deletionFence);
      }
    }, options);
    if (leaseStillExists && (!agentId || row.agent_id === agentId)) {
      const remediation = agentId ? "." : "; stop that process and rerun openclaw doctor --fix.";
      throw new OpenClawAgentDatabaseLeaseActiveError(
        `Agent ${row.agent_id} database is still open in another process${remediation}`,
      );
    }
  }
}
