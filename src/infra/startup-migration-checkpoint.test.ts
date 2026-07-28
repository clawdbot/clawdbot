// Startup migration checkpoint tests cover shared-state version records and leases.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  acquireStartupMigrationLease,
  hasActiveStartupMigrationLease,
  needsStartupMigrationCheckpoint,
  readStartupMigrationVersion,
  recordSuccessfulStartupMigrations,
} from "./startup-migration-checkpoint.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const startupMigrationTempDirs = useAutoCleanupTempDirTracker(afterEach);

type StartupMigrationLeaseTestDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;

/** Rewrites only the recorded owner start time so the live owner PID looks recycled. */
function overwriteStartupMigrationLeaseOwnerStartedAt(
  env: NodeJS.ProcessEnv,
  startedAt: number,
): void {
  withOpenClawStateStartupMigrationCheckpointDatabase(
    (db) => {
      const kysely = getNodeSqliteKysely<StartupMigrationLeaseTestDatabase>(db);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("state_leases").select("payload_json as payloadJson"),
      );
      const payload = JSON.parse(row?.payloadJson ?? "{}") as { owner?: { startedAt?: number } };
      executeSqliteQuerySync(
        db,
        kysely.updateTable("state_leases").set({
          payload_json: JSON.stringify({ ...payload, owner: { ...payload.owner, startedAt } }),
        }),
      );
    },
    { env },
  );
}

describe("startup migration checkpoint", () => {
  it("checks migration activity without creating shared state", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const dbPath = resolveOpenClawStateSqlitePath(env);

    expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("records the migrated OpenClaw version in shared state", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };

    expect(readStartupMigrationVersion(env)).toBeNull();
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(true);

    recordSuccessfulStartupMigrations({
      env,
      version: "2026.7.1",
      buildIdentity: "2026-07-11T00:00:00.000Z",
      nowMs: 1234,
    });

    expect(readStartupMigrationVersion(env)).toBe("2026.7.1");
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:01:00.000Z",
      }),
    ).toBe(true);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.2",
        buildIdentity: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("keeps the fast path disabled without immutable build provenance", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };

    recordSuccessfulStartupMigrations({
      env,
      version: "2026.7.1",
      buildIdentity: null,
      nowMs: 1234,
    });

    expect(needsStartupMigrationCheckpoint({ env, version: "2026.7.1", buildIdentity: null })).toBe(
      true,
    );
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("serializes startup migrations with an expiring shared-state lease", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(true);

    expect(() => acquireStartupMigrationLease({ env, nowMs: 1001, owner: "second" })).toThrow(
      `OpenClaw startup migrations are already running for this state directory; retry after the other gateway finishes or after 1970-01-01T00:05:01.000Z. (held by pid ${process.pid})`,
    );

    lease.release();

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(false);

    const next = acquireStartupMigrationLease({ env, nowMs: 1002, owner: "second" });
    next.release();
  });

  it("reclaims an active startup migration lease whose owner process is gone", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const deadPid = 2_147_483_647;
    const stale = acquireStartupMigrationLease({
      env,
      nowMs: 1000,
      owner: "stale",
      ownerPid: deadPid,
    });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(false);

    const replacement = acquireStartupMigrationLease({ env, nowMs: 1001, owner: "replacement" });
    stale.release();
    expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(true);
    replacement.release();
  });

  // PID numbers are recycled by the OS. Without the start-time guard a stale lease whose PID was
  // reassigned to an unrelated live process would block startup for the full TTL.
  it.skipIf(process.platform === "win32")(
    "reclaims a startup migration lease whose owner PID was recycled",
    () => {
      const env = {
        OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
      };
      const stale = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "stale" });

      // The owner PID is this live test process; only the recorded start identity is stale.
      overwriteStartupMigrationLeaseOwnerStartedAt(env, 1);

      expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(false);

      const replacement = acquireStartupMigrationLease({ env, nowMs: 1001, owner: "replacement" });
      stale.release();
      expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(true);
      replacement.release();
    },
  );

  it("does not report an expired startup migration lease as active", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 301_001 })).toBe(false);

    lease.release();
  });

  it("renews startup migration leases while the owner is still running", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });

    lease.heartbeat({ nowMs: 300_000 });

    expect(() => acquireStartupMigrationLease({ env, nowMs: 301_001, owner: "second" })).toThrow(
      "OpenClaw startup migrations are already running",
    );

    lease.release();
  });

  it("does not checkpoint startup migrations after the lease is lost", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const first = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    const second = acquireStartupMigrationLease({ env, nowMs: 400_000, owner: "second" });

    expect(() =>
      recordSuccessfulStartupMigrations({
        env,
        lease: first,
        version: "2026.7.1",
        nowMs: 400_001,
      }),
    ).toThrow("startup migration lease was lost");
    expect(readStartupMigrationVersion(env)).toBeNull();

    second.release();
  });

  it("reads the checkpoint without requiring the full state schema to be canonical", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const sqlite = requireNodeSqlite();
    const dbPath = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        size_bytes INTEGER
      );
    `);
    db.close();

    expect(needsStartupMigrationCheckpoint({ env, version: "2026.7.1" })).toBe(true);
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    lease.release();
  });

  it("refuses future-version state databases before creating checkpoint tables", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const sqlite = requireNodeSqlite();
    const dbPath = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    db.close();

    expect(() => acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" })).toThrow(
      `newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
    );

    const verify = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = verify
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'state_leases'")
      .get() as { ok?: unknown } | undefined;
    verify.close();
    expect(row).toBeUndefined();
  });
});
