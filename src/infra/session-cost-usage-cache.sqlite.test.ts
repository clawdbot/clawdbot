import fs from "node:fs";
import path from "node:path";
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
  deleteSessionCostUsageRollupsExcept,
  isSessionCostUsageRefreshRunning,
  readSessionCostUsageRollupRows,
  writeSessionCostUsageRollup,
} from "./session-cost-usage-cache.sqlite.js";

const tempDirs: string[] = [];

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

  it.each([
    { label: "changed totals", refreshedValue: '{"totalTokens":2}' },
    { label: "unchanged totals at a newer revision", refreshedValue: '{"totalTokens":1}' },
  ])("preserves a refreshed usage rollup with $label during pruning", ({ refreshedValue }) => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-prune-race-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const agentId = "worker-1";
      const rollupId = "session.jsonl";
      const staleValue = '{"totalTokens":1}';

      expect(
        writeSessionCostUsageRollup({
          agentId,
          rollupId,
          previousValueJson: null,
          valueJson: staleValue,
          updatedAt: 1,
        }),
      ).toBe(true);
      const rows = readSessionCostUsageRollupRows(agentId);

      const liveKeys = new (class extends Set<string> {
        override has(key: string): boolean {
          if (key === rollupId) {
            expect(
              writeSessionCostUsageRollup({
                agentId,
                rollupId,
                previousValueJson: staleValue,
                valueJson: refreshedValue,
                updatedAt: 2,
              }),
            ).toBe(true);
          }
          return false;
        }
      })();

      deleteSessionCostUsageRollupsExcept({ agentId, liveKeys, rows });

      expect(readSessionCostUsageRollupRows(agentId)).toEqual([
        { key: rollupId, updatedAt: 2, valueJson: refreshedValue },
      ]);
    });
  });

  it("reads only v2 rollups and prunes retired usage cache rows by scope", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-retired-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const agentId = "worker-1";
      expect(
        writeSessionCostUsageRollup({
          agentId,
          rollupId: "current.jsonl",
          previousValueJson: null,
          valueJson: '{"version":2}',
          updatedAt: 2,
        }),
      ).toBe(true);
      const database = openOpenClawAgentDatabase({ agentId });
      const insert = database.db.prepare(
        "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
      );
      insert.run("session-cost-usage-rollup-v1", "retired.jsonl", '{"version":1}', 1);
      insert.run("session-cost-usage", "cache", "{}", 1);
      insert.run("session-cost-usage", "refresh-lock", "{}", 1);
      insert.run("other", "keep", "{}", 1);

      const rows = readSessionCostUsageRollupRows(agentId);
      expect(rows).toEqual([{ key: "current.jsonl", updatedAt: 2, valueJson: '{"version":2}' }]);

      deleteSessionCostUsageRollupsExcept({
        agentId,
        liveKeys: new Set(["current.jsonl"]),
        rows,
      });

      expect(
        database.db.prepare("SELECT scope, key FROM cache_entries ORDER BY scope, key").all(),
      ).toEqual([
        { key: "keep", scope: "other" },
        { key: "refresh-lock", scope: "session-cost-usage" },
        { key: "current.jsonl", scope: "session-cost-usage-rollup-v2" },
      ]);
    });
  });
});
