// Startup migration checkpoint tests cover shared-state version records and leases.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
  runOpenClawStateWriteTransaction,
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
  needsStateMigrationCheckpoint,
  needsStartupMigrationCheckpoint,
  readStartupMigrationVersion,
  recordSuccessfulStateMigrations,
  recordSuccessfulStartupMigrations,
  STARTUP_MIGRATION_LEASE_TTL_MS,
} from "./startup-migration-checkpoint.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const startupMigrationTempDirs = useAutoCleanupTempDirTracker(afterEach);

type StartupMigrationLeaseTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "schema_meta" | "state_leases"
>;

const migrationIdentity = {
  effectiveConfigFingerprint: "effective-config",
  pluginDoctorConfigFingerprint: "plugin-doctor-config",
  pluginMigrationFingerprint: "plugin-migrations",
};

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
        identity: migrationIdentity,
      }),
    ).toBe(true);
    expect(
      needsStateMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
        identity: migrationIdentity,
      }),
    ).toBe(true);

    recordSuccessfulStartupMigrations({
      env,
      version: "2026.7.1",
      buildIdentity: "2026-07-11T00:00:00.000Z",
      identity: migrationIdentity,
      nowMs: 1234,
    });

    expect(readStartupMigrationVersion(env)).toBe("2026.7.1");
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
        identity: migrationIdentity,
      }),
    ).toBe(false);
    expect(
      needsStateMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
        identity: migrationIdentity,
      }),
    ).toBe(false);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:01:00.000Z",
        identity: migrationIdentity,
      }),
    ).toBe(true);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.2",
        buildIdentity: "2026-07-11T00:00:00.000Z",
        identity: migrationIdentity,
      }),
    ).toBe(true);
    for (const [field, value] of [
      ["effectiveConfigFingerprint", "effective-config-changed"],
      ["pluginDoctorConfigFingerprint", "plugin-doctor-config-changed"],
      ["pluginMigrationFingerprint", "plugin-migrations-changed"],
    ] as const) {
      expect(
        needsStartupMigrationCheckpoint({
          env,
          version: "2026.7.1",
          buildIdentity: "2026-07-11T00:00:00.000Z",
          identity: { ...migrationIdentity, [field]: value },
        }),
      ).toBe(true);
    }
  });

  it("keeps state-only completion narrower than gateway startup", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const checkpoint = {
      env,
      version: "2026.7.1",
      buildIdentity: "2026-07-11T00:00:00.000Z",
      identity: migrationIdentity,
    };

    recordSuccessfulStateMigrations({ ...checkpoint, nowMs: 1234 });

    expect(needsStateMigrationCheckpoint(checkpoint)).toBe(false);
    expect(needsStartupMigrationCheckpoint(checkpoint)).toBe(true);
    expect(readStartupMigrationVersion(env)).toBeNull();
  });

  it("keeps the fast path disabled without immutable build provenance", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };

    recordSuccessfulStartupMigrations({
      env,
      version: "2026.7.1",
      buildIdentity: null,
      identity: migrationIdentity,
      nowMs: 1234,
    });

    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: null,
        identity: migrationIdentity,
      }),
    ).toBe(true);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
        identity: migrationIdentity,
      }),
    ).toBe(true);
    expect(
      needsStartupMigrationCheckpoint({
        env,
        version: "2026.7.1",
        buildIdentity: "2026-07-11T00:00:00.000Z",
        identity: null,
      }),
    ).toBe(true);
  });

  it("treats legacy build-only checkpoints as stale once", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const checkpoint = {
      env,
      version: "2026.7.1",
      buildIdentity: "2026-07-11T00:00:00.000Z",
      identity: migrationIdentity,
    };
    recordSuccessfulStartupMigrations({ ...checkpoint, nowMs: 1234 });
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) => {
        const kysely = getNodeSqliteKysely<StartupMigrationLeaseTestDatabase>(db);
        executeSqliteQuerySync(
          db,
          kysely.updateTable("schema_meta").set({
            app_version: `${checkpoint.version}\n${checkpoint.buildIdentity}`,
            schema_version: 2,
          }),
        );
      },
      { env },
    );

    expect(needsStartupMigrationCheckpoint(checkpoint)).toBe(true);
    expect(needsStateMigrationCheckpoint(checkpoint)).toBe(true);
    expect(readStartupMigrationVersion(env)).toBe("2026.7.1");
  });

  it("serializes startup migrations with an expiring shared-state lease", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(true);

    expect(() => acquireStartupMigrationLease({ env, nowMs: 1001, owner: "second" })).toThrow(
      `OpenClaw startup migrations are already running for this state directory; retry after the other OpenClaw process finishes or after 1970-01-01T00:05:01.000Z. (held by pid ${process.pid})`,
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
        buildIdentity: "2026-07-11T00:00:00.000Z",
        identity: migrationIdentity,
        nowMs: 400_001,
      }),
    ).toThrow("startup migration lease was lost");
    expect(readStartupMigrationVersion(env)).toBeNull();

    second.release();
  });

  it("checks exact lease ownership inside the caller write transaction", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const nowMs = Date.now();
    const first = acquireStartupMigrationLease({ env, nowMs, owner: "first" });
    const second = acquireStartupMigrationLease({
      env,
      nowMs: nowMs + STARTUP_MIGRATION_LEASE_TTL_MS + 1,
      owner: "second",
    });

    runOpenClawStateWriteTransaction(
      ({ db }) => {
        expect(() => first.assertOwnedInTransaction(db)).toThrow(
          "startup migration lease was lost",
        );
        expect(() => second.assertOwnedInTransaction(db)).not.toThrow();
      },
      { env },
    );

    first.release();
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
