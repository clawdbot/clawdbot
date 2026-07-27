import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnv } from "../test-utils/env.js";
import {
  acquireSessionCostUsageRefreshLock,
  isSessionCostUsageRefreshRunning,
  readSessionCostUsageRollupRows,
  writeSessionCostUsageRollup,
} from "./session-cost-usage-cache.sqlite.js";

const tempDirs: string[] = [];

const REFRESH_LOCK_SCOPE = "session-cost-usage";
const REFRESH_LOCK_KEY = "refresh-lock";

function writeRefreshLockRow(
  agentId: string,
  lock: { pid: number; startedAt: number; ownerNonce: string },
): void {
  const database = openOpenClawAgentDatabase({ agentId });
  database.db
    .prepare(
      `INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json,
                                             updated_at = excluded.updated_at`,
    )
    .run(REFRESH_LOCK_SCOPE, REFRESH_LOCK_KEY, JSON.stringify(lock), Math.round(lock.startedAt));
  closeOpenClawAgentDatabasesForTest();
}

function countRegisteredAgentDatabases(): number {
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT count(*) AS count FROM agent_databases")
    .get() as {
    count: number;
  };
  return row.count;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("session cost usage SQLite cache", () => {
  it("returns empty values without creating a missing agent database", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-missing-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "worker-1" });

      expect(readSessionCostUsageRollupRows("worker-1", databasePath)).toEqual([]);
      expect(isSessionCostUsageRefreshRunning("worker-1", databasePath)).toBe(false);
      expect(fs.existsSync(databasePath)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
    });
  });

  it("does not register readonly cache reads while writes still register", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-registry-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const agentId = "worker-1";
      const database = openOpenClawAgentDatabase({ agentId });
      const databasePath = database.path;
      closeOpenClawAgentDatabasesForTest();

      const stateDatabase = openOpenClawStateDatabase();
      stateDatabase.db.prepare("DELETE FROM agent_databases").run();
      expect(countRegisteredAgentDatabases()).toBe(0);

      expect(readSessionCostUsageRollupRows(agentId, databasePath)).toEqual([]);
      expect(isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(false);
      expect(countRegisteredAgentDatabases()).toBe(0);

      expect(
        writeSessionCostUsageRollup({
          agentId,
          databasePath,
          rollupId: "session.jsonl",
          previousValueJson: null,
          valueJson: "{}",
          updatedAt: 1,
        }),
      ).toBe(true);
      expect(countRegisteredAgentDatabases()).toBe(1);
    });
  });

  it("reclaims a refresh lock left by an earlier incarnation that reused this PID", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-orphan-lock-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const agentId = "worker-1";
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId });
      // A supervised gateway restarts into the same PID, so the leaked row from the
      // previous incarnation still points at a live PID -- ours. Only `startedAt`,
      // which predates this process, reveals that we never owned it.
      writeRefreshLockRow(agentId, {
        pid: process.pid,
        startedAt: Math.round(performance.timeOrigin) - 60_000,
        ownerNonce: "previous-incarnation-nonce",
      });

      expect(isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(false);

      const lock = acquireSessionCostUsageRefreshLock(agentId, databasePath);
      expect(lock.acquired).toBe(true);
      lock.release();
    });
  });

  it("treats a refresh lock predating the last boot as stale", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-preboot-lock-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const agentId = "worker-1";
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId });
      // PID 1 is always running, so liveness alone cannot retire this row.
      writeRefreshLockRow(agentId, {
        pid: 1,
        startedAt: 0,
        ownerNonce: "pre-boot-nonce",
      });

      expect(isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(false);
    });
  });

  it("keeps a refresh lock this process actually holds", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-live-lock-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const agentId = "worker-1";
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId });

      const lock = acquireSessionCostUsageRefreshLock(agentId, databasePath);
      expect(lock.acquired).toBe(true);
      expect(isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(true);
      expect(acquireSessionCostUsageRefreshLock(agentId, databasePath).acquired).toBe(false);

      lock.release();
      expect(isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(false);
      const reacquired = acquireSessionCostUsageRefreshLock(agentId, databasePath);
      expect(reacquired.acquired).toBe(true);
      reacquired.release();
    });
  });
});
