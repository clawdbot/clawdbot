import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "./openclaw-state-db.generated.js";

export type OpenClawStateLeaseIdentity = { scope: string; key: string; owner: string };
type LeaseDatabase = Pick<DB, "state_leases">;

/** The caller owns the write transaction; only absent or expired leases can be acquired. */
export function acquireOpenClawStateLeaseInTransaction(
  db: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
  leaseMs: number,
): number | undefined {
  // BEGIN IMMEDIATE may wait on SQLite. Sample only after admission so a
  // successful insert never commits an already-expired lease.
  const now = Date.now();
  const kysely = getNodeSqliteKysely<LeaseDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("state_leases")
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("expires_at", "<=", now),
  );
  const expiresAt = now + leaseMs;
  const inserted = executeSqliteQuerySync(
    db,
    kysely
      .insertInto("state_leases")
      .values({
        scope: identity.scope,
        lease_key: identity.key,
        owner: identity.owner,
        expires_at: expiresAt,
        heartbeat_at: now,
        payload_json: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.columns(["scope", "lease_key"]).doNothing()),
  );
  return inserted.numAffectedRows === 1n ? expiresAt : undefined;
}

export function readOpenClawStateLeaseExpiry(
  db: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
): number | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .selectFrom("state_leases")
      .select("expires_at")
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("owner", "=", identity.owner)
      .where("expires_at", ">", Date.now())
      .$narrowType<{ expires_at: number }>(),
  )?.expires_at;
}

/** The caller owns the write transaction; expired or replaced owners cannot renew. */
export function renewOpenClawStateLeaseInTransaction(
  db: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
  leaseMs: number,
): number | undefined {
  const now = Date.now();
  const expiresAt = now + leaseMs;
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .updateTable("state_leases")
      .set({ expires_at: expiresAt, heartbeat_at: now, updated_at: now })
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("owner", "=", identity.owner)
      .where("expires_at", ">", now),
  );
  return result.numAffectedRows === 1n ? expiresAt : undefined;
}

/** The caller owns the write transaction; a replaced owner cannot release its successor. */
export function releaseOpenClawStateLeaseInTransaction(
  db: DatabaseSync,
  identity: OpenClawStateLeaseIdentity,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<LeaseDatabase>(db)
      .deleteFrom("state_leases")
      .where("scope", "=", identity.scope)
      .where("lease_key", "=", identity.key)
      .where("owner", "=", identity.owner),
  );
}
