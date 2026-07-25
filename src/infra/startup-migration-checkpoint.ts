// Coordinates gateway startup migration version checkpoints in shared state.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

type StartupMigrationCheckpointDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "schema_meta" | "state_leases"
>;

const STARTUP_MIGRATION_META_KEY = "startup-migrations";
const STARTUP_MIGRATION_BUILD_SEPARATOR = "\n";
const STARTUP_MIGRATION_LEASE_SCOPE = "startup-migrations";
const STARTUP_MIGRATION_LEASE_KEY = "global";
export const STARTUP_MIGRATION_LEASE_TTL_MS = 5 * 60_000;

export type StartupMigrationLease = {
  heartbeat: (params?: { nowMs?: number }) => void;
  release: () => void;
  readonly owner: string;
};

function formatStartupMigrationCheckpoint(version: string, buildIdentity: string): string {
  return `${version}${STARTUP_MIGRATION_BUILD_SEPARATOR}${buildIdentity}`;
}

// Built-at provenance changes when mutable source is rebuilt even if package version and commit do
// not. Missing provenance deliberately keeps migrations enabled instead of trusting stale code.
function resolveStartupMigrationBuildIdentity(moduleUrl: string = import.meta.url): string | null {
  try {
    const require = createRequire(moduleUrl);
    for (const candidate of [
      "./build-info.json",
      "../build-info.json",
      "../../dist/build-info.json",
    ]) {
      try {
        const info = require(candidate) as { builtAt?: unknown };
        if (typeof info.builtAt !== "string" || !info.builtAt.trim()) {
          continue;
        }
        return info.builtAt.trim();
      } catch {
        // Try the next packaged/source-build location.
      }
    }
  } catch {
    // Missing build provenance disables the fast path below.
  }
  return null;
}

function withStartupMigrationCheckpointDatabase<T>(
  env: NodeJS.ProcessEnv,
  callback: (db: DatabaseSync) => T,
): T {
  return withOpenClawStateStartupMigrationCheckpointDatabase(callback, { env });
}

function writeStartupMigrationCheckpointDatabase<T>(
  env: NodeJS.ProcessEnv,
  callback: (db: DatabaseSync) => T,
): T {
  return withStartupMigrationCheckpointDatabase(env, (db) =>
    runSqliteImmediateTransactionSync(db, () => callback(db)),
  );
}

function readStartupMigrationCheckpoint(env: NodeJS.ProcessEnv): string | null {
  return withStartupMigrationCheckpointDatabase(env, (db) => {
    const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("schema_meta")
        .select("app_version as appVersion")
        .where("meta_key", "=", STARTUP_MIGRATION_META_KEY),
    );
    return row?.appVersion ?? null;
  });
}

export function readStartupMigrationVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    readStartupMigrationCheckpoint(env)?.split(STARTUP_MIGRATION_BUILD_SEPARATOR, 1)[0] ?? null
  );
}

/** Returns whether the canonical gateway startup-migration lease is still live. */
export function hasActiveStartupMigrationLease(
  params: { env?: NodeJS.ProcessEnv; nowMs?: number } = {},
): boolean {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const pathname = resolveOpenClawStateSqlitePath(env);
  if (!existsSync(pathname)) {
    return false;
  }
  return withOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
      return Boolean(
        executeSqliteQueryTakeFirstSync(
          db,
          stateDb
            .selectFrom("state_leases")
            .select("owner")
            .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
            .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
            .where("expires_at", ">", nowMs),
        ),
      );
    },
    { env },
  );
}

export function needsStartupMigrationCheckpoint(
  params: {
    buildIdentity?: string | null;
    env?: NodeJS.ProcessEnv;
    version?: string;
  } = {},
): boolean {
  const env = params.env ?? process.env;
  const buildIdentity =
    params.buildIdentity === undefined
      ? resolveStartupMigrationBuildIdentity()
      : params.buildIdentity;
  if (buildIdentity === null) {
    return true;
  }
  return (
    readStartupMigrationCheckpoint(env) !==
    formatStartupMigrationCheckpoint(params.version ?? VERSION, buildIdentity)
  );
}

export function acquireStartupMigrationLease(
  params: {
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
    owner?: string;
  } = {},
): StartupMigrationLease {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const owner = params.owner ?? randomUUID();
  const expiresAt = nowMs + STARTUP_MIGRATION_LEASE_TTL_MS;

  writeStartupMigrationCheckpointDatabase(env, (db) => {
    const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("state_leases")
        .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
        .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
        .where("expires_at", "<=", nowMs),
    );
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("state_leases")
        .select(["owner", "expires_at as expiresAt"])
        .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
        .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY),
    );
    if (existing) {
      throw new Error(
        `OpenClaw startup migrations are already running for this state directory; retry after the other gateway finishes or after ${new Date(existing.expiresAt ?? expiresAt).toISOString()}.`,
      );
    }
    executeSqliteQuerySync(
      db,
      stateDb.insertInto("state_leases").values({
        scope: STARTUP_MIGRATION_LEASE_SCOPE,
        lease_key: STARTUP_MIGRATION_LEASE_KEY,
        owner,
        expires_at: expiresAt,
        heartbeat_at: nowMs,
        payload_json: JSON.stringify({ version: VERSION }),
        created_at: nowMs,
        updated_at: nowMs,
      }),
    );
  });

  return {
    owner,
    heartbeat: (heartbeatParams = {}) => {
      const heartbeatNowMs = heartbeatParams.nowMs ?? Date.now();
      const heartbeatExpiresAt = heartbeatNowMs + STARTUP_MIGRATION_LEASE_TTL_MS;
      writeStartupMigrationCheckpointDatabase(env, (db) => {
        const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
        const result = executeSqliteQuerySync(
          db,
          stateDb
            .updateTable("state_leases")
            .set({
              expires_at: heartbeatExpiresAt,
              heartbeat_at: heartbeatNowMs,
              updated_at: heartbeatNowMs,
            })
            .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
            .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
            .where("owner", "=", owner)
            .where("expires_at", ">", heartbeatNowMs),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(
            "OpenClaw startup migration lease was lost before startup migrations completed; restart the gateway so migrations can run under a fresh lease.",
          );
        }
      });
    },
    release: () => {
      writeStartupMigrationCheckpointDatabase(env, (db) => {
        const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .deleteFrom("state_leases")
            .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
            .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
            .where("owner", "=", owner),
        );
      });
    },
  };
}

export function recordSuccessfulStartupMigrations(
  params: {
    buildIdentity?: string | null;
    env?: NodeJS.ProcessEnv;
    lease?: StartupMigrationLease;
    version?: string;
    nowMs?: number;
  } = {},
): void {
  const env = params.env ?? process.env;
  const version = params.version ?? VERSION;
  const buildIdentity =
    params.buildIdentity === undefined
      ? resolveStartupMigrationBuildIdentity()
      : params.buildIdentity;
  const nowMs = params.nowMs ?? Date.now();
  const checkpoint =
    buildIdentity === null ? version : formatStartupMigrationCheckpoint(version, buildIdentity);
  writeStartupMigrationCheckpointDatabase(env, (db) => {
    const stateDb = getNodeSqliteKysely<StartupMigrationCheckpointDatabase>(db);
    if (params.lease) {
      const activeLease = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("state_leases")
          .select("owner")
          .where("scope", "=", STARTUP_MIGRATION_LEASE_SCOPE)
          .where("lease_key", "=", STARTUP_MIGRATION_LEASE_KEY)
          .where("owner", "=", params.lease.owner)
          .where("expires_at", ">", nowMs),
      );
      if (!activeLease) {
        throw new Error(
          "OpenClaw startup migration lease was lost before checkpoint recording; restart the gateway so migrations can run under a fresh lease.",
        );
      }
    }
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("schema_meta")
        .values({
          meta_key: STARTUP_MIGRATION_META_KEY,
          role: "global",
          schema_version: buildIdentity === null ? 1 : 2,
          agent_id: null,
          app_version: checkpoint,
          created_at: nowMs,
          updated_at: nowMs,
        })
        .onConflict((conflict) =>
          conflict.column("meta_key").doUpdateSet({
            role: "global",
            schema_version: buildIdentity === null ? 1 : 2,
            agent_id: null,
            app_version: checkpoint,
            updated_at: nowMs,
          }),
        ),
    );
  });
}
