// Subagent registry SQLite store tests cover canonical whole-snapshot persistence.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-one",
    childSessionKey: "agent:main:subagent:one",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "check sqlite persistence",
    cleanup: "keep",
    createdAt: 100,
    startedAt: 110,
    endedAt: 250,
    outcome: { status: "ok", startedAt: 110, endedAt: 250, elapsedMs: 140 },
    expectsCompletionMessage: true,
    completion: {
      required: true,
      resultText: "done",
      capturedAt: 260,
    },
    delivery: {
      status: "pending",
      createdAt: 270,
      lastAttemptAt: 280,
      attemptCount: 2,
      lastError: "retry later",
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey: "agent:main:subagent:one",
        childRunId: "run-one",
        task: "check sqlite persistence",
        startedAt: 110,
        endedAt: 250,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
      },
    },
    ...overrides,
  };
}

describe("subagent registry sqlite store", () => {
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-sqlite-"));
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
  });

  async function withTempStateEnv<T>(fn: () => Promise<T>): Promise<T> {
    if (!tempStateDir) {
      throw new Error("expected temp state dir");
    }
    return await withEnvAsync({ OPENCLAW_STATE_DIR: tempStateDir }, fn);
  }

  it("persists subagent runs in the shared sqlite state database", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
        endedReason: "subagent-error",
        outcome: { status: "error", error: "restart interrupted run", endedAt: 250 },
        terminalOwner: "interrupted-recovery",
        completion: { required: true, resultText: null, capturedAt: 250 },
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          replayCount: 1,
          nextAttemptAt: 30_000,
          batchRunIds: ["run-one", "run-two"],
          lastError: "provider timeout",
          retireAfterSettle: true,
        },
      });

      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const restored = loadSubagentRegistryFromSqlite();
      expect(restored.get(run.runId)).toMatchObject({
        runId: run.runId,
        childSessionKey: run.childSessionKey,
        requesterSessionKey: run.requesterSessionKey,
        task: run.task,
        endedAt: run.endedAt,
        outcome: run.outcome,
        terminalOwner: "interrupted-recovery",
        completion: run.completion,
        delivery: run.delivery,
        requesterSettleWake: run.requesterSettleWake,
      });
      expect(await fs.stat(path.join(tempStateDir!, "state", "openclaw.sqlite"))).toBeTruthy();
      await expect(fs.stat(path.join(tempStateDir!, "subagents", "runs.json"))).rejects.toThrow();
    });
  });

  it("uses save calls as whole-registry snapshots", async () => {
    await withTempStateEnv(async () => {
      const first = createRun({ runId: "run-one", childSessionKey: "agent:main:subagent:one" });
      const second = createRun({ runId: "run-two", childSessionKey: "agent:main:subagent:two" });

      saveSubagentRegistryToSqlite(
        new Map([
          [first.runId, first],
          [second.runId, second],
        ]),
      );
      saveSubagentRegistryToSqlite(new Map([[second.runId, second]]));

      expect([...loadSubagentRegistryFromSqlite().keys()]).toEqual(["run-two"]);
    });
  });

  it("preserves announcedAt for not_required delivery when completion was announced", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
        expectsCompletionMessage: false,
        completion: { required: false },
        delivery: { status: "not_required", announcedAt: 300 },
      });

      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const restored = loadSubagentRegistryFromSqlite();
      const restoredRun = restored.get(run.runId)!;
      expect(restoredRun.delivery?.status).toBe("not_required");
      expect(restoredRun.delivery?.announcedAt).toBe(300);
      expect(restoredRun.delivery?.deliveredAt).toBeUndefined();
    });
  });

  it("repairs a tainted delivered status when completion is not required", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
        expectsCompletionMessage: false,
        completion: { required: false },
        delivery: { status: "not_required", announcedAt: 300 },
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const { db } = openOpenClawStateDatabase();
      const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("subagent_runs")
          .set({
            payload_json: JSON.stringify({
              ...run,
              delivery: { status: "delivered", announcedAt: 300, deliveredAt: 300 },
            }),
          })
          .where("run_id", "=", run.runId),
      );

      const restoredRun = loadSubagentRegistryFromSqlite().get(run.runId)!;
      expect(restoredRun.delivery).toMatchObject({
        status: "not_required",
        announcedAt: 300,
        deliveredAt: 300,
      });
    });
  });

  it("does not read or delete the retired JSON registry at runtime", async () => {
    await withTempStateEnv(async () => {
      const legacyRun = createRun({
        runId: "legacy-run",
        childSessionKey: "agent:main:subagent:legacy",
        task: "retired legacy registry",
      });
      const registryPath = path.join(tempStateDir!, "subagents", "runs.json");
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(
        registryPath,
        `${JSON.stringify({ version: 2, runs: { [legacyRun.runId]: legacyRun } })}\n`,
        "utf8",
      );

      const restored = loadSubagentRegistryFromSqlite();

      expect(restored).toEqual(new Map());
      await expect(fs.stat(registryPath)).resolves.toBeTruthy();
      expect(
        openOpenClawStateDatabase().db.prepare("SELECT COUNT(*) AS count FROM subagent_runs").get(),
      ).toEqual({ count: 0 });
    });
  });
});
