import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type ClawPackageLifecycleDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;

type ClawPackageLifecycleArtifact =
  | { kind: "plugin"; source: "clawhub"; ref: string }
  | { kind: "skill"; source: "clawhub"; ref: string; workspace: string };

type ClawPackageLifecycleLease = {
  heartbeat: (nowMs?: number) => void;
  release: () => void;
};

export type MaintainedClawPackageLifecycleLease = {
  assertCurrent: () => void;
  release: () => void;
};

type ClawPackageLifecycleLeaseOptions = OpenClawStateDatabaseOptions & {
  nowMs?: number;
  owner?: string;
  required?: boolean;
};

const LEASE_SCOPE = "claw-package-lifecycle";
const LEASE_TTL_MS = 5 * 60_000;

class ClawPackageLifecycleBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawPackageLifecycleBusyError";
  }
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<ClawPackageLifecycleDatabase>(db);
}

function packageLeaseKey(artifact: ClawPackageLifecycleArtifact): string {
  if (artifact.kind === "skill") {
    return `skill:${artifact.source}:workspace:${resolve(artifact.workspace)}`;
  }
  return `${artifact.kind}:${artifact.source}:${artifact.ref}`;
}

/** Serializes shared package ownership and artifact mutation across processes. */
export function acquireClawPackageLifecycleLease(
  artifact: ClawPackageLifecycleArtifact,
  options: ClawPackageLifecycleLeaseOptions = {},
): ClawPackageLifecycleLease | null {
  const env = options.env ?? process.env;
  const databasePath = options.path ?? resolveOpenClawStateSqlitePath(env);
  const nowMs = options.nowMs ?? Date.now();
  const expiresAt = nowMs + LEASE_TTL_MS;
  const owner = options.owner ?? randomUUID();
  const leaseKey = packageLeaseKey(artifact);
  let acquired = false;

  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const state = kyselyFor(db);
        executeSqliteQuerySync(
          db,
          state
            .deleteFrom("state_leases")
            .where("scope", "=", LEASE_SCOPE)
            .where("lease_key", "=", leaseKey)
            .where("expires_at", "<=", nowMs),
        );
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          state
            .selectFrom("state_leases")
            .select("expires_at")
            .where("scope", "=", LEASE_SCOPE)
            .where("lease_key", "=", leaseKey),
        );
        if (existing) {
          throw new ClawPackageLifecycleBusyError(
            `Package ${artifact.ref} is being changed by another OpenClaw lifecycle; retry after ${new Date(existing.expires_at ?? expiresAt).toISOString()}.`,
          );
        }
        executeSqliteQuerySync(
          db,
          state.insertInto("state_leases").values({
            scope: LEASE_SCOPE,
            lease_key: leaseKey,
            owner,
            expires_at: expiresAt,
            heartbeat_at: nowMs,
            payload_json: JSON.stringify(artifact),
            created_at: nowMs,
            updated_at: nowMs,
          }),
        );
        acquired = true;
      },
      { env, path: databasePath },
    );
  } catch (error) {
    if (options.required || error instanceof ClawPackageLifecycleBusyError) {
      throw error;
    }
    return null;
  }

  if (!acquired) {
    return null;
  }
  return {
    heartbeat: (heartbeatNowMs = Date.now()) => {
      const heartbeatExpiresAt = heartbeatNowMs + LEASE_TTL_MS;
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const result = executeSqliteQuerySync(
            db,
            kyselyFor(db)
              .updateTable("state_leases")
              .set({
                expires_at: heartbeatExpiresAt,
                heartbeat_at: heartbeatNowMs,
                updated_at: heartbeatNowMs,
              })
              .where("scope", "=", LEASE_SCOPE)
              .where("lease_key", "=", leaseKey)
              .where("owner", "=", owner)
              .where("expires_at", ">", heartbeatNowMs),
          );
          if (result.numAffectedRows !== 1n) {
            throw new Error(`Package lifecycle lease was lost for ${artifact.ref}.`);
          }
        },
        { env, path: databasePath },
      );
    },
    release: () => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            kyselyFor(db)
              .deleteFrom("state_leases")
              .where("scope", "=", LEASE_SCOPE)
              .where("lease_key", "=", leaseKey)
              .where("owner", "=", owner),
          );
        },
        { env, path: databasePath },
      );
    },
  };
}

/** Renews an acquired lease while an asynchronous package mutation is in flight. */
export function maintainClawPackageLifecycleLease(
  lease: ClawPackageLifecycleLease,
): MaintainedClawPackageLifecycleLease {
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    try {
      lease.heartbeat();
    } catch (error) {
      heartbeatError ??= error;
    }
  }, LEASE_TTL_MS / 3);
  heartbeat.unref();
  return {
    assertCurrent: () => {
      if (heartbeatError) {
        throw heartbeatError instanceof Error
          ? heartbeatError
          : new Error(formatErrorMessage(heartbeatError));
      }
      lease.heartbeat();
    },
    release: () => {
      clearInterval(heartbeat);
      lease.release();
    },
  };
}

async function releaseMaintainedClawPackageLifecycleLease(
  lease: MaintainedClawPackageLifecycleLease,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      lease.release();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(formatErrorMessage(lastError));
}

export async function withClawPackageLifecycleLease<T>(
  artifact: ClawPackageLifecycleArtifact,
  operation: () => Promise<T>,
  options: ClawPackageLifecycleLeaseOptions = {},
): Promise<T> {
  const lease = acquireClawPackageLifecycleLease(artifact, options);
  if (!lease) {
    return await operation();
  }
  const maintained = maintainClawPackageLifecycleLease(lease);
  try {
    const result = await operation();
    maintained.assertCurrent();
    return result;
  } finally {
    try {
      await releaseMaintainedClawPackageLifecycleLease(maintained);
    } catch {
      // Preserve the operation result. Expiry recovers cleanup that remains
      // unreachable after the bounded retries.
    }
  }
}
