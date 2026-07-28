import crypto from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  assertAgentDeletionIdentityClaimAllowed,
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { ensureAgentDatabaseLeaseSchema } from "./openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";

type AgentDatabaseLeaseDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_database_leases" | "agent_deletion_journal"
>;

export function claimOpenClawAgentDatabaseLease(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const deletionFence = prepareAgentDeletionPathFence(
    { agentId, path: params.path },
    { env: params.env },
  );
  const leaseId = crypto.randomUUID();
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  runOpenClawStateWriteTransaction(
    (database) => {
      ensureAgentDatabaseLeaseSchema(database.db);
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
      const deletion = executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("agent_deletion_journal").select("agent_id").where("agent_id", "=", agentId),
      );
      assertAgentDeletionIdentityClaimAllowed(agentId, deletion?.agent_id);
      assertAgentDeletionPathFence(database.db, deletionFence);
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

export function assertNoOpenClawAgentDatabaseLeases(
  agentIdRaw: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const agentId = normalizeAgentId(agentIdRaw);
  let rows: Array<{
    agent_id: string;
    lease_id: string;
    owner_pid: number;
    owner_start_time: number | null;
    path: string;
  }> = [];
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDatabaseLeaseSchema(database.db);
    const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
    rows = executeSqliteQuerySync(
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
    const deletionFence = prepareAgentDeletionPathFence(
      { agentId: row.agent_id, path: row.path, fenceAgentId: agentId },
      options,
    );
    let leaseStillExists = false;
    runOpenClawStateWriteTransaction((database) => {
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
      if (leaseStillExists && row.agent_id !== agentId) {
        assertAgentDeletionPathFence(database.db, deletionFence);
      }
    }, options);
    if (leaseStillExists && row.agent_id === agentId) {
      throw new Error(`Agent ${agentId} database is still open in another process.`);
    }
  }
}
