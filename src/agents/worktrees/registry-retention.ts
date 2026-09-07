import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { ensureWorktreeRetentionClaimsSchema } from "./retention-schema.js";
import { WORKTREE_REMOVING_LEASE_KEY, worktreeRunLeaseScope } from "./run-lease-owner.js";
import type { ManagedWorktreeOwnerKind } from "./types.js";

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
  // Terminal claims can disappear only with their immutable registry identity.
  // Removing or restoring a checkout alone must not revive an old generation.
  executeSqliteQuerySync(
    db,
    k.deleteFrom("worktree_retention_claims").where("worktree_id", "=", worktreeId),
  );
}

export function deleteRegistryWorktree(env: NodeJS.ProcessEnv, id: string): void {
  ensureWorktreeRetentionClaimsSchema(env);
  const db = dbFor(env);
  const k = kyselyFor(db);
  runOpenClawStateWriteTransaction(
    () => {
      executeSqliteQuerySync(
        db,
        k.deleteFrom("worktree_provisioned_file_chunks").where("worktree_id", "=", id),
      );
      deleteWorktreeLeaseAndRetentionRows(db, id);
      executeSqliteQuerySync(db, k.deleteFrom("worktrees").where("id", "=", id));
    },
    { env },
  );
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
      .where("released_at", "is", null)
      .limit(1),
  ).rows[0]?.claim_id;
}

export function setWorktreeRetentionClaimRow(
  env: NodeJS.ProcessEnv,
  params: {
    worktreeId: string;
    claimId: string;
    ownerKind: ManagedWorktreeOwnerKind;
    ownerId: string;
    active: boolean;
    now: number;
  },
): boolean {
  ensureWorktreeRetentionClaimsSchema(env);
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = database.db;
      const k = kyselyFor(db);
      const record = executeSqliteQuerySync(
        db,
        k
          .selectFrom("worktrees")
          .select(["removed_at", "owner_kind", "owner_id"])
          .where("id", "=", params.worktreeId),
      ).rows[0];
      if (!record) {
        return !params.active;
      }
      if (record.owner_kind !== params.ownerKind || record.owner_id !== params.ownerId) {
        return false;
      }
      const claim = executeSqliteQuerySync(
        db,
        k
          .selectFrom("worktree_retention_claims")
          .select("released_at")
          .where("worktree_id", "=", params.worktreeId)
          .where("claim_id", "=", params.claimId),
      ).rows[0];
      if (claim?.released_at != null) {
        return !params.active;
      }
      if (params.active) {
        if (record.removed_at !== null) {
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
      }
      // Release is terminal even when it arrives before acquisition. The caller's
      // durable cancellation must fence an already-dispatched, delayed acquire.
      const releasedAt = params.active ? null : params.now;
      executeSqliteQuerySync(
        db,
        k
          .insertInto("worktree_retention_claims")
          .values({
            worktree_id: params.worktreeId,
            claim_id: params.claimId,
            claim_owner: `${params.ownerKind}:${params.ownerId}`,
            created_at: params.now,
            updated_at: params.now,
            released_at: releasedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["worktree_id", "claim_id"]).doUpdateSet({
              updated_at: params.now,
              released_at: releasedAt,
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
