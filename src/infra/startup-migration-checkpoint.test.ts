// Startup migration checkpoint tests cover shared-state version records and leases.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  OpenClawStateOwnershipError,
  STATE_SUPERVISION_KEY,
} from "../state/openclaw-state-ownership.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  acquireStartupMigrationLease,
  acquireStartupMigrationLeaseWithWait,
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
  vi.restoreAllMocks();
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

  it("initializes the canonical schema before creating the first startup checkpoint", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-fresh-"),
    };

    expect(readStartupMigrationVersion(env)).toBeNull();

    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(env), { readOnly: true });
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        database
          .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      expect(
        database
          .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'plugin_state_entries'")
          .get(),
      ).toEqual({ present: 1 });
    } finally {
      database.close();
    }
  });

  it.each([false, true])(
    "adopts native version-zero state before checkpoint access (existing checkpoint: %s)",
    (hasExistingCheckpoint) => {
      const env = {
        OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-native-"),
      };
      const databasePath = resolveOpenClawStateSqlitePath(env);
      mkdirSync(path.dirname(databasePath), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const native = new DatabaseSync(databasePath);
      native.exec(`
        CREATE TABLE device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY,
          device_id TEXT NOT NULL,
          public_key_pem TEXT NOT NULL,
          private_key_pem TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_device_identities_device
          ON device_identities(device_id, updated_at_ms DESC);
        INSERT INTO device_identities VALUES ('node', 'native-device', 'public', 'private', 1, 1);
        CREATE TABLE exec_approvals_config (
          config_key TEXT NOT NULL PRIMARY KEY,
          raw_json TEXT NOT NULL,
          socket_path TEXT,
          has_socket_token INTEGER NOT NULL,
          default_security TEXT,
          default_ask TEXT,
          default_ask_fallback TEXT,
          auto_allow_skills INTEGER,
          agent_count INTEGER NOT NULL,
          allowlist_count INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        ) STRICT;
        INSERT INTO exec_approvals_config
          VALUES ('current', '{}', NULL, 0, NULL, NULL, NULL, NULL, 0, 0, 1);
      `);
      if (hasExistingCheckpoint) {
        native.exec(`
          CREATE TABLE schema_meta (
            meta_key TEXT NOT NULL PRIMARY KEY,
            role TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            agent_id TEXT,
            app_version TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE state_leases (
            scope TEXT NOT NULL,
            lease_key TEXT NOT NULL,
            owner TEXT NOT NULL,
            expires_at INTEGER,
            heartbeat_at INTEGER,
            payload_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (scope, lease_key)
          );
          CREATE INDEX idx_state_leases_expiry
            ON state_leases(expires_at, scope, lease_key)
            WHERE expires_at IS NOT NULL;
          CREATE INDEX idx_state_leases_owner
            ON state_leases(owner, updated_at DESC);
        `);
      }
      native.close();

      const lease = acquireStartupMigrationLease({ env, owner: "native-bootstrap" });
      try {
        const initialized = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(initialized.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_STATE_SCHEMA_VERSION,
          });
          expect(
            initialized
              .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
              .get(),
          ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
          expect(
            initialized
              .prepare("SELECT device_id FROM device_identities WHERE identity_key = 'node'")
              .get(),
          ).toEqual({ device_id: "native-device" });
          expect(
            initialized
              .prepare("SELECT config_key FROM exec_approvals_config WHERE config_key = 'current'")
              .get(),
          ).toEqual({ config_key: "current" });
        } finally {
          initialized.close();
        }
      } finally {
        lease.release();
      }
    },
  );

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

  it("rechecks external ownership inside the final lease write transaction", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    runOpenClawStateWriteTransaction(() => undefined, { env });
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const { DatabaseSync } = requireNodeSqlite();
    const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
      | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
      | undefined;
    if (!originalExec) {
      throw new Error("DatabaseSync.exec descriptor is unavailable");
    }
    // Schema setup commits before the lease helper starts its own transaction.
    // Claim at that exact boundary so the final transaction must fence the new owner.
    let immediateTransactionCount = 0;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: import("node:sqlite").DatabaseSync,
      sql: string,
    ) {
      if (sql === "BEGIN IMMEDIATE" && ++immediateTransactionCount === 2) {
        const claimant = new DatabaseSync(databasePath);
        try {
          claimant
            .prepare(
              `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
               VALUES (?, ?, ?)`,
            )
            .run(
              STATE_SUPERVISION_KEY,
              JSON.stringify({
                version: 1,
                mode: "external",
                managerId: "race-manager",
                claimedAt: 1,
              }),
              1,
            );
        } finally {
          claimant.close();
        }
      }
      return originalExec.call(this, sql);
    });

    try {
      expect(() => acquireStartupMigrationLease({ env, owner: "unmarked", nowMs: 1 })).toThrow(
        OpenClawStateOwnershipError,
      );
    } finally {
      exec.mockRestore();
    }

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        verify
          .prepare(
            `SELECT COUNT(*) AS count
             FROM state_leases
             WHERE scope = 'startup-migrations' AND lease_key = 'global'`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        verify
          .prepare(
            `SELECT COUNT(*) AS count
             FROM schema_meta
             WHERE meta_key IN ('state-migrations', 'startup-migrations')`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      verify.close();
    }
  });

  it("waits for a live same-host startup migration lease to be released", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    let nowMs = 1001;
    let elapsedMs = 0;
    let sleepCount = 0;
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });
    const checkpoint = {
      env,
      version: "2026.7.1",
      buildIdentity: "2026-07-11T00:00:00.000Z",
      identity: migrationIdentity,
    };

    expect(needsStartupMigrationCheckpoint(checkpoint)).toBe(true);

    const acquired = await acquireStartupMigrationLeaseWithWait({
      env,
      owner: "second",
      timeoutMs: 1000,
      pollIntervalMs: 250,
      now: () => nowMs,
      monotonicNow: () => elapsedMs,
      sleep: async (ms) => {
        sleepCount += 1;
        recordSuccessfulStartupMigrations({ ...checkpoint, lease, nowMs });
        lease.release();
        nowMs += ms;
        elapsedMs += ms;
      },
    });

    expect(sleepCount).toBe(1);
    expect(acquired.owner).toBe("second");
    expect(needsStartupMigrationCheckpoint(checkpoint)).toBe(false);
    acquired.release();
  });

  it("preserves the existing lease error when the wait bound expires", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    let nowMs = 1001;
    let elapsedMs = 0;
    const lease = acquireStartupMigrationLease({ env, nowMs: 1000, owner: "first" });

    await expect(
      acquireStartupMigrationLeaseWithWait({
        env,
        owner: "second",
        timeoutMs: 500,
        pollIntervalMs: 250,
        now: () => nowMs,
        monotonicNow: () => elapsedMs,
        sleep: async (ms) => {
          nowMs += ms;
          elapsedMs += ms;
        },
      }),
    ).rejects.toThrow(
      `OpenClaw startup migrations are already running for this state directory; retry after the other OpenClaw process finishes or after 1970-01-01T00:05:01.000Z. (held by pid ${process.pid})`,
    );

    lease.release();
  });

  it("reclaims an active startup migration lease whose owner process is gone", async () => {
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

    const replacement = await acquireStartupMigrationLeaseWithWait({
      env,
      owner: "replacement",
      now: () => 1001,
    });
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
    const leased = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    expect(leased.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    leased.close();
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
