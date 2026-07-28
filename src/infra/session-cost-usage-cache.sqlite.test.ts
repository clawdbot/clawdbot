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
import { readUsageCostRollups } from "./session-cost-usage-aggregation.js";
import {
  deleteSessionCostUsageRollupsExcept,
  isSessionCostUsageRefreshRunning,
  readSessionCostUsageRollupPricingFingerprint,
  readSessionCostUsageRollupRows,
  resetSessionCostUsageRollupScope,
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

  it("stores the pricing fingerprint once per scope, not per rollup row", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-fingerprint-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const agentId = "worker-1";
      // Stand-in for the hosted catalog pricing payload (openclaw/openclaw#115282).
      const pricingFingerprint = "x".repeat(256 * 1024);

      resetSessionCostUsageRollupScope({ agentId, pricingFingerprint, updatedAt: 1 });
      expect(readSessionCostUsageRollupPricingFingerprint(agentId)).toBe(pricingFingerprint);

      for (let index = 0; index < 5; index += 1) {
        expect(
          writeSessionCostUsageRollup({
            agentId,
            rollupId: `/sessions/${index}.jsonl`,
            previousValueJson: null,
            valueJson: `{"version":3,"totalTokens":${index}}`,
            updatedAt: index + 1,
          }),
        ).toBe(true);
      }

      const rows = readSessionCostUsageRollupRows(agentId);
      expect(rows).toHaveLength(5);
      // The scope metadata row is never mixed into per-session rollup rows, and
      // no row payload carries the multi-megabyte fingerprint.
      for (const row of rows) {
        expect(row.key).not.toBe("__usage_cost_rollup_meta__");
        expect(row.valueJson.length).toBeLessThan(1024);
      }

      // Pruning keeps the scope metadata row intact.
      deleteSessionCostUsageRollupsExcept({
        agentId,
        liveKeys: new Set(rows.map((r) => r.key)),
        rows,
      });
      expect(readSessionCostUsageRollupPricingFingerprint(agentId)).toBe(pricingFingerprint);
    });
  });

  it("rotates the scope on fingerprint change and purges legacy v1 rollup rows", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-rotate-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const agentId = "worker-1";
      resetSessionCostUsageRollupScope({
        agentId,
        pricingFingerprint: "fingerprint-a",
        updatedAt: 1,
      });
      expect(
        writeSessionCostUsageRollup({
          agentId,
          rollupId: "/sessions/current.jsonl",
          previousValueJson: null,
          valueJson: '{"version":3,"totalTokens":1}',
          updatedAt: 1,
        }),
      ).toBe(true);

      // Seed an abandoned pre-v2 row with the duplicated per-row fingerprint.
      const database = openOpenClawAgentDatabase({ agentId });
      database.db
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
        )
        .run(
          "session-cost-usage-rollup-v1",
          "/sessions/legacy.jsonl",
          JSON.stringify({ version: 2, pricingFingerprint: "x".repeat(1024) }),
          1,
        );
      closeOpenClawAgentDatabasesForTest();

      resetSessionCostUsageRollupScope({
        agentId,
        pricingFingerprint: "fingerprint-b",
        updatedAt: 2,
      });

      expect(readSessionCostUsageRollupPricingFingerprint(agentId)).toBe("fingerprint-b");
      expect(readSessionCostUsageRollupRows(agentId)).toEqual([]);
      const verify = openOpenClawAgentDatabase({ agentId });
      const legacyRows = verify.db
        .prepare("SELECT count(*) AS count FROM cache_entries WHERE scope = ?")
        .get("session-cost-usage-rollup-v1") as { count: number };
      expect(legacyRows.count).toBe(0);
    });
  });

  it("treats every rollup as stale when the scope pricing fingerprint differs", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-usage-cache-mismatch-");

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const agentId = "worker-1";
      resetSessionCostUsageRollupScope({
        agentId,
        pricingFingerprint: "fingerprint-a",
        updatedAt: 1,
      });
      const entry = {
        version: 3,
        checkpoint: {
          kind: "jsonl",
          parsedOffset: 0,
          observedSize: 0,
          observedMtimeMs: 0,
          device: 0,
          inode: 0,
          anchorHash: "anchor",
        },
        scannedAt: 1,
        parsedRecords: 0,
        countedRecords: 0,
        rollup: {},
      };
      expect(
        writeSessionCostUsageRollup({
          agentId,
          rollupId: "/sessions/a.jsonl",
          previousValueJson: null,
          valueJson: JSON.stringify(entry),
          updatedAt: 1,
        }),
      ).toBe(true);

      expect(readUsageCostRollups(agentId, "fingerprint-a").size).toBe(1);
      // Mismatch short-circuits before any rollup JSON is materialized.
      expect(readUsageCostRollups(agentId, "fingerprint-b").size).toBe(0);
      expect(readSessionCostUsageRollupRows(agentId)).toHaveLength(1);
    });
  });
});
