// Startup migration checkpoint tests cover shared-state version records and leases.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  acquireStartupMigrationLease,
  needsStartupMigrationCheckpoint,
  readStartupMigrationVersion,
  recordSuccessfulStartupMigrations,
} from "./startup-migration-checkpoint.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const startupMigrationTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("startup migration checkpoint", () => {
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

    expect(() => acquireStartupMigrationLease({ env, nowMs: 1001, owner: "second" })).toThrow(
      "OpenClaw startup migrations are already running",
    );

    lease.release();

    const next = acquireStartupMigrationLease({ env, nowMs: 1002, owner: "second" });
    next.release();
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
