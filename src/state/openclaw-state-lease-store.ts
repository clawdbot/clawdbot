import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "./openclaw-state-db.generated.js";

export type OpenClawStateLeaseIdentity = { scope: string; key: string; owner: string };
type LeaseDatabase = Pick<DB, "state_leases">;

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
