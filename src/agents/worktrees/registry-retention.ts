import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { ensureWorktreeRetentionClaimsSchema } from "./retention-schema.js";
import { WORKTREE_REMOVING_LEASE_KEY, worktreeRunLeaseScope } from "./run-lease-owner.js";

type WorktreeRetentionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "worktrees" | "state_leases" | "worktree_retention_claims" | "worktree_provisioned_file_chunks"
>;

function dbFor(env: NodeJS.ProcessEnv): DatabaseSync {
  return openOpenClawStateDatabase({ env }).db;
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<WorktreeRetentionDatabase>(db);
}

function deleteWorktreeLeaseAndRetentionRows(db: DatabaseSync, worktreeId: string): void {
  const k = kyselyFor(db);
  executeSqliteQuerySync(
    db,
    k.deleteFrom("state_leases").where("scope", "=", worktreeRunLeaseScope(worktreeId)),
  );
  executeSqliteQuerySync(
    db,
    k.deleteFrom("worktree_retention_claims").where("worktree_id", "=", worktreeId),
  );
}

export function deleteRegistryWorktree(env: NodeJS.ProcessEnv, id: string): void {
  ensureWorktreeRetentionClaimsSchema(env);
  const db = dbFor(env);
  const k = kyselyFor(db);
  runOpenClawStateWriteTransaction(() => {
    executeSqliteQuerySync(
      db,
      k.deleteFrom("worktree_provisioned_file_chunks").where("worktree_id", "=", id),
    );
    deleteWorktreeLeaseAndRetentionRows(db, id);
    executeSqliteQuerySync(db, k.deleteFrom("worktrees").where("id", "=", id));
  });
}

export function findWorktreeRetentionClaimId(
  db: DatabaseSync,
  worktreeId: string,
): string | undefined {
  return executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .selectFrom("worktree_retention_claims")
      .select("claim_id")
      .where("worktree_id", "=", worktreeId)
      .limit(1),
  ).rows[0]?.claim_id;
}

export function setWorktreeRetentionClaimRow(
  env: NodeJS.ProcessEnv,
  params: {
    worktreeId: string;
    claimId: string;
    claimOwner: string;
    active: boolean;
    now: number;
  },
): boolean {
  ensureWorktreeRetentionClaimsSchema(env);
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = database.db;
      const k = kyselyFor(db);
      if (!params.active) {
        executeSqliteQuerySync(
          db,
          k
            .deleteFrom("worktree_retention_claims")
            .where("worktree_id", "=", params.worktreeId)
            .where("claim_id", "=", params.claimId),
        );
        return true;
      }
      const record = executeSqliteQuerySync(
        db,
        k.selectFrom("worktrees").select(["removed_at"]).where("id", "=", params.worktreeId),
      ).rows[0];
      if (!record || record.removed_at !== null) {
        return false;
      }
      const removing = executeSqliteQuerySync(
        db,
        k
          .selectFrom("state_leases")
          .select("owner")
          .where("scope", "=", worktreeRunLeaseScope(params.worktreeId))
          .where("lease_key", "=", WORKTREE_REMOVING_LEASE_KEY)
          .limit(1),
      ).rows[0];
      if (removing) {
        throw new Error("worktree removal is already in progress");
      }
      executeSqliteQuerySync(
        db,
        k
          .insertInto("worktree_retention_claims")
          .values({
            worktree_id: params.worktreeId,
            claim_id: params.claimId,
            claim_owner: params.claimOwner,
            created_at: params.now,
            updated_at: params.now,
          })
          .onConflict((conflict) =>
            conflict.columns(["worktree_id", "claim_id"]).doUpdateSet({
              claim_owner: params.claimOwner,
              updated_at: params.now,
            }),
          ),
      );
      return true;
    },
    { env },
  );
}

export function hasWorktreeRetentionClaimRow(env: NodeJS.ProcessEnv, worktreeId: string): boolean {
  ensureWorktreeRetentionClaimsSchema(env);
  return findWorktreeRetentionClaimId(dbFor(env), worktreeId) !== undefined;
}
