import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { runExistingOpenClawStateWriteTransaction } from "./openclaw-state-db-existing-write.js";
import { ensureAgentDatabaseLeaseSchema } from "./openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

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

const maintenanceAuthority = new AsyncLocalStorage<{
  authority: OpenClawStateLeaseContext;
  databasePath: string;
}>();

export function runWithAgentDatabaseMaintenanceAuthority<T>(
  authority: OpenClawStateLeaseContext,
  databasePath: string,
  run: () => Promise<T>,
): Promise<T> {
  return maintenanceAuthority.run({ authority, databasePath: path.resolve(databasePath) }, run);
}

/** Revalidate the held lease, including immediately before committing a versioned rebuild. */
export function assertAgentDatabaseMaintenanceAuthority(
  expected?: OpenClawStateLeaseContext,
): void {
  const authority = maintenanceAuthority.getStore()?.authority;
  if (!authority || (expected && authority !== expected)) {
    throw new Error(
      "Agent identity migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.",
    );
  }
  authority.assertOwned();
}

/** Revalidate a maintenance owner when present, without requiring ordinary opens to hold one. */
export function assertAgentDatabaseMaintenanceAuthorityIfPresent(): void {
  maintenanceAuthority.getStore()?.authority.assertOwned();
}

/** Verify the maintenance owner and its independent heartbeat before a synchronous phase. */
export function renewAgentDatabaseMaintenanceAuthorityIfPresent(): void {
  const authority = maintenanceAuthority.getStore()?.authority;
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
  const maintenance = maintenanceAuthority.getStore();
  const databasePath = path.resolve(
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(options.env),
  );
  if (maintenance?.databasePath === databasePath) {
    return withExistingAgentLeaseWrite(maintenance.authority, options, (database) => {
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database);
      executeSqliteQuerySync(
        database,
        db.deleteFrom("agent_database_leases").where("lease_id", "=", leaseId),
      );
    });
  }
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

export function assertNoOpenClawAgentDatabaseLeases(
  agentIdRaw: string | OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions & { schemaPolicy?: "existing" } = {},
): void {
  if (options.schemaPolicy === "existing") {
    if (typeof agentIdRaw === "string") {
      throw new Error("Existing-schema agent drainage requires a real maintenance owner.");
    }
    return assertNoExistingAgentDatabaseLeases(agentIdRaw, options);
  }
  const maintenance = typeof agentIdRaw === "string" ? undefined : agentIdRaw;
  const agentId = typeof agentIdRaw === "string" ? normalizeAgentId(agentIdRaw) : undefined;
  const rows = runOpenClawStateWriteTransaction((database) => {
    maintenance?.assertOwnedInTransaction(database.db);
    ensureAgentDatabaseLeaseSchema(database.db);
    const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
    return executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("agent_database_leases")
        .select(["agent_id", "lease_id", "owner_pid", "owner_start_time", "path"]),
    ).rows;
  }, options);

  const staleLeaseIds = rows
    .filter((row) => {
      if (isPidDefinitelyDead(row.owner_pid)) {
        return true;
      }
      const currentStartTime = getFileLockProcessStartTime(row.owner_pid);
      return (
        row.owner_start_time !== null &&
        currentStartTime !== null &&
        row.owner_start_time !== currentStartTime
      );
    })
    .map((row) => row.lease_id);
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

const existingAgentLeaseSchema = ["schema_meta", "state_leases", "agent_database_leases"]
  .map((table) => {
    const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(") STRICT;", start);
    if (start < 0 || end < 0) {
      throw new Error("Existing agent lease schema is unavailable.");
    }
    return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + ") STRICT;".length);
  })
  .join("\n");

function withExistingAgentLeaseWrite<T>(
  maintenance: OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions,
  operation: (db: DatabaseSync) => T,
): T {
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      maintenance.assertOwnedInTransaction(db);
      const result = operation(db);
      maintenance.assertOwnedInTransaction(db);
      return result;
    },
    options,
    {
      operationLabel: "agent.database.maintenance.admission",
      schemaSql: existingAgentLeaseSchema,
      busyTimeoutMs: 0,
    },
  );
}

/** Stable existing rows can be drained before the candidate is allowed to migrate. */
function assertNoExistingAgentDatabaseLeases(
  maintenance: OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions,
): void {
  withExistingAgentLeaseWrite(maintenance, options, (db) => {
    const query = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      query
        .selectFrom("agent_database_leases")
        .select(["agent_id", "lease_id", "owner_pid", "owner_start_time"]),
    ).rows;
    for (const row of rows) {
      const currentStart = getFileLockProcessStartTime(row.owner_pid);
      if (
        isPidDefinitelyDead(row.owner_pid) ||
        (row.owner_start_time !== null &&
          currentStart !== null &&
          row.owner_start_time !== currentStart)
      ) {
        executeSqliteQuerySync(
          db,
          query.deleteFrom("agent_database_leases").where("lease_id", "=", row.lease_id),
        );
      } else {
        throw new OpenClawAgentDatabaseLeaseActiveError(
          `Agent ${row.agent_id} database is still open in another process; stop that process and retry.`,
        );
      }
    }
  });
}
