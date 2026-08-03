// Subagent registry SQLite store tests cover canonical snapshot and exact-row persistence.
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
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  saveSubagentRegistryChangesToSqlite,
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
    expectsCompletionMessage: true,
    execution: {
      status: "terminal",
      startedAt: 110,
      endedAt: 250,
      outcome: { status: "ok", startedAt: 110, endedAt: 250, elapsedMs: 140 },
    },
    completion: {
      required: true,
      resultText: "done",
      capturedAt: 260,
      terminalReply: { disposition: "visible", text: "done" },
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
        requesterTurnRunId: "run-requester",
        requesterTurnYielded: true,
        retireAfterRequesterTurn: true,
        endedReason: "subagent-error",
        execution: {
          status: "terminal",
          startedAt: 110,
          endedAt: 250,
          outcome: { status: "error", error: "restart interrupted run", endedAt: 250 },
        },
        terminalOwner: "interrupted-recovery",
        completion: { required: true, resultText: null, capturedAt: 250 },
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          replayCount: 1,
          nextAttemptAt: 30_000,
          batchRunIds: ["run-one", "run-two"],
          requesterYieldBatch: true,
          afterRequesterYield: true,
          rearmGeneration: 3,
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
        requesterTurnRunId: "run-requester",
        requesterTurnYielded: true,
        retireAfterRequesterTurn: true,
        execution: run.execution,
        terminalOwner: "interrupted-recovery",
        completion: run.completion,
        delivery: run.delivery,
        requesterSettleWake: run.requesterSettleWake,
      });
      expect(await fs.stat(path.join(tempStateDir!, "state", "openclaw.sqlite"))).toBeTruthy();
      await expect(fs.stat(path.join(tempStateDir!, "subagents", "runs.json"))).rejects.toThrow();
    });
  });

  it.each([
    {
      name: "visible",
      terminalReply: { disposition: "visible", text: "restart-visible" } as const,
      resultText: "restart-visible",
    },
    {
      name: "silent",
      terminalReply: { disposition: "silent" } as const,
      resultText: "NO_REPLY",
    },
    {
      name: "empty",
      terminalReply: { disposition: "empty" } as const,
      resultText: null,
    },
  ])(
    "restores $name terminal reply in completion and pending delivery after restart",
    async ({ name, terminalReply, resultText }) => {
      await withTempStateEnv(async () => {
        const runId = `run-restart-${name}`;
        const run = createRun({
          runId,
          childSessionKey: `agent:main:subagent:${name}`,
          completion: {
            required: true,
            resultText,
            capturedAt: 260,
            terminalReply,
          },
          delivery: {
            status: "pending",
            createdAt: 270,
            attemptCount: 0,
            payload: {
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              childSessionKey: `agent:main:subagent:${name}`,
              childRunId: runId,
              task: "check terminal reply restart",
              startedAt: 110,
              endedAt: 250,
              outcome: { status: "ok" },
              expectsCompletionMessage: true,
              terminalReply,
            },
          },
        });

        saveSubagentRegistryToSqlite(new Map([[runId, run]]));
        closeOpenClawStateDatabaseForTest();

        const restored = loadSubagentRegistryFromSqlite().get(runId);
        expect(restored?.completion).toMatchObject({ terminalReply, resultText });
        expect(restored?.delivery).toMatchObject({
          status: "pending",
          payload: { terminalReply },
        });
      });
    },
  );

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

  it("keeps the complete payload authoritative over stale derived state columns", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 2,
          batchRunIds: ["run-one"],
        },
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const { db } = openOpenClawStateDatabase();
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<SubagentRegistryDatabase>(db)
          .updateTable("subagent_runs")
          .set({
            expects_completion_message: 0,
            frozen_result_text: "stale typed completion",
            pending_final_delivery_last_error: "stale typed delivery",
            requester_settle_wake_status: "pending",
            requester_settle_wake_attempt_count: 99,
            outcome_json: JSON.stringify({ status: "timeout" }),
          })
          .where("run_id", "=", run.runId),
      );

      closeOpenClawStateDatabaseForTest();
      const restored = loadSubagentRegistryFromSqlite().get(run.runId);
      expect(restored?.expectsCompletionMessage).toBe(true);
      expect(restored?.completion?.resultText).toBe("done");
      expect(restored?.delivery).toMatchObject({ status: "pending", lastError: "retry later" });
      expect(restored?.requesterSettleWake).toEqual(run.requesterSettleWake);
      expect(restored?.execution.outcome?.status).toBe("ok");
      const sessionListRun = loadSubagentSessionListRunsFromSqlite().get(run.runId);
      expect(sessionListRun?.execution.outcome?.status).toBe("ok");
      expect(sessionListRun?.delivery?.status).toBe("pending");
    });
  });

  it("promotes legacy retained results into canonical completion state once", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
        completion: { required: true, resultText: "NO_REPLY" },
        delivery: {
          status: "suspended",
          suspendedAt: 300,
          suspendedReason: "retry-limit",
          payload: {
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            childSessionKey: "agent:main:subagent:one",
            childRunId: "run-one",
            task: "check sqlite persistence",
            outcome: { status: "ok" },
            expectsCompletionMessage: true,
            frozenResultText: "NO_REPLY",
            fallbackFrozenResultText: "legacy retained result",
          } as NonNullable<SubagentRunRecord["delivery"]>["payload"] & {
            frozenResultText: string;
            fallbackFrozenResultText: string;
          },
        },
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      closeOpenClawStateDatabaseForTest();

      const restored = loadSubagentRegistryFromSqlite().get(run.runId);
      expect(restored?.completion).toMatchObject({
        resultText: "NO_REPLY",
        fallbackResultText: "legacy retained result",
      });
      expect(restored?.delivery?.payload).not.toHaveProperty("frozenResultText");
      expect(restored?.delivery?.payload).not.toHaveProperty("fallbackFrozenResultText");

      const stored = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT payload_json, frozen_result_text, fallback_frozen_result_text FROM subagent_runs WHERE run_id = ?",
        )
        .get(run.runId) as {
        payload_json: string;
        frozen_result_text: string | null;
        fallback_frozen_result_text: string | null;
      };
      expect(stored.frozen_result_text).toBe("NO_REPLY");
      expect(stored.fallback_frozen_result_text).toBe("legacy retained result");
      const storedPayload = JSON.parse(stored.payload_json) as SubagentRunRecord;
      expect(storedPayload.completion).toMatchObject({
        required: true,
        resultText: "NO_REPLY",
        fallbackResultText: "legacy retained result",
      });
      expect(storedPayload.delivery?.payload).not.toHaveProperty("frozenResultText");
      expect(storedPayload.delivery?.payload).not.toHaveProperty("fallbackFrozenResultText");

      closeOpenClawStateDatabaseForTest();
      expect(loadSubagentRegistryFromSqlite().get(run.runId)?.completion).toMatchObject({
        resultText: "NO_REPLY",
        fallbackResultText: "legacy retained result",
      });
    });
  });

  it("loads a canonical lightweight session-list projection", async () => {
    await withTempStateEnv(async () => {
      const run = createRun({
        model: "openai/gpt-5.6",
        generation: 3,
        sessionStartedAt: 105,
        accumulatedRuntimeMs: 90,
        runTimeoutSeconds: 7_200,
        endedReason: "subagent-error",
        cleanupCompletedAt: 300,
        execution: {
          status: "terminal",
          startedAt: 110,
          endedAt: 250,
          outcome: { status: "error", error: "full payload detail" },
        },
        delivery: {
          status: "suspended",
          suspendedAt: 275,
          suspendedReason: "expiry",
        },
        task: "x".repeat(8_192),
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      expect(loadSubagentSessionListRunsFromSqlite().get(run.runId)).toEqual({
        runId: run.runId,
        childSessionKey: run.childSessionKey,
        requesterSessionKey: run.requesterSessionKey,
        model: "openai/gpt-5.6",
        generation: 3,
        createdAt: 100,
        execution: {
          startedAt: 110,
          endedAt: 250,
          outcome: { status: "error" },
        },
        sessionStartedAt: 105,
        accumulatedRuntimeMs: 90,
        runTimeoutSeconds: 7_200,
        endedReason: "subagent-error",
        cleanupCompletedAt: 300,
        delivery: { status: "suspended", suspendedAt: 275 },
      });
    });
  });

  it("writes only named registry mutations", async () => {
    await withTempStateEnv(async () => {
      const first = createRun({ runId: "run-one", childSessionKey: "agent:main:subagent:one" });
      const removed = createRun({ runId: "run-two", childSessionKey: "agent:main:subagent:two" });
      const untouched = createRun({
        runId: "run-three",
        childSessionKey: "agent:main:subagent:three",
      });
      const runs = new Map([first, removed, untouched].map((run) => [run.runId, run] as const));
      saveSubagentRegistryToSqlite(runs);

      const { db } = openOpenClawStateDatabase();
      db.exec(`
        CREATE TEMP TABLE subagent_run_write_audit (
          action TEXT NOT NULL,
          run_id TEXT NOT NULL
        );
        CREATE TEMP TRIGGER subagent_run_audit_insert
        AFTER INSERT ON subagent_runs
        BEGIN
          INSERT INTO subagent_run_write_audit VALUES ('insert', NEW.run_id);
        END;
        CREATE TEMP TRIGGER subagent_run_audit_update
        AFTER UPDATE ON subagent_runs
        BEGIN
          INSERT INTO subagent_run_write_audit VALUES ('update', NEW.run_id);
        END;
        CREATE TEMP TRIGGER subagent_run_audit_delete
        AFTER DELETE ON subagent_runs
        BEGIN
          INSERT INTO subagent_run_write_audit VALUES ('delete', OLD.run_id);
        END;
      `);

      first.task = "updated task";
      runs.delete(removed.runId);
      saveSubagentRegistryChangesToSqlite(runs, [first.runId, removed.runId]);

      expect(
        db.prepare("SELECT action, run_id FROM subagent_run_write_audit ORDER BY rowid").all(),
      ).toEqual([
        { action: "update", run_id: first.runId },
        { action: "delete", run_id: removed.runId },
      ]);
      expect([...loadSubagentRegistryFromSqlite().entries()]).toMatchObject([
        [first.runId, { task: "updated task" }],
        [untouched.runId, { task: untouched.task }],
      ]);
    });
  });

  it("rejects writes outside the canonical nested state", async () => {
    await withTempStateEnv(async () => {
      const missingState = createRun({ execution: undefined });
      const retiredState = createRun();
      Object.assign(retiredState.delivery!, { handoffLeaseId: "lease-1" });
      const invalidStatus = createRun({
        execution: { status: "running\n" } as unknown as SubagentRunRecord["execution"],
      });

      for (const run of [missingState, retiredState, invalidStatus]) {
        expect(() => saveSubagentRegistryToSqlite(new Map([[run.runId, run]]))).toThrow(
          "subagent run is missing canonical nested state",
        );
      }
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
            expects_completion_message: 1,
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

  it("ignores rows with retired flat delivery state", async () => {
    await withTempStateEnv(async () => {
      const run = createRun();
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const { db } = openOpenClawStateDatabase();
      db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?").run(
        JSON.stringify({
          ...run,
          execution: undefined,
          completion: undefined,
          delivery: undefined,
          pendingFinalDelivery: true,
        }),
        run.runId,
      );

      expect(loadSubagentRegistryFromSqlite()).toEqual(new Map());
      expect(loadSubagentSessionListRunsFromSqlite()).toEqual(new Map());

      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?").run(
        JSON.stringify({ ...run, delivery: "pending" }),
        run.runId,
      );
      expect(loadSubagentRegistryFromSqlite()).toEqual(new Map());
      expect(loadSubagentSessionListRunsFromSqlite()).toEqual(new Map());
    });
  });

  it("loads explicit controller rows and null-controller requester fallbacks", async () => {
    await withTempStateEnv(async () => {
      const explicit = createRun({
        runId: "explicit",
        controllerSessionKey: "agent:main:controller",
        requesterSessionKey: "agent:main:other",
      });
      const fallback = createRun({
        runId: "fallback",
        controllerSessionKey: undefined,
        requesterSessionKey: "agent:main:controller",
      });
      const emptyController = createRun({
        runId: "empty-controller",
        controllerSessionKey: "",
        requesterSessionKey: "agent:main:controller",
      });
      const paddedController = createRun({
        runId: "padded-controller",
        controllerSessionKey: " agent:main:controller ",
        requesterSessionKey: "agent:main:other",
      });
      const other = createRun({
        runId: "other",
        controllerSessionKey: "agent:main:other-controller",
        requesterSessionKey: "agent:main:controller",
      });
      saveSubagentRegistryToSqlite(
        new Map([
          [explicit.runId, explicit],
          [fallback.runId, fallback],
          [emptyController.runId, emptyController],
          [paddedController.runId, paddedController],
          [other.runId, other],
        ]),
      );

      expect(
        loadSubagentRunsForControllerFromSqlite("agent:main:controller").map((run) => run.runId),
      ).toEqual(["empty-controller", "explicit", "fallback", "padded-controller"]);
      expect(
        loadSubagentRunsForControllerFromSqlite("agent:main:controller").at(-1)
          ?.controllerSessionKey,
      ).toBe("agent:main:controller");
      expect(loadSubagentRunsForControllerFromSqlite("   ")).toEqual([]);
    });
  });

  it("loads only the requested child session in deterministic storage order", async () => {
    await withTempStateEnv(async () => {
      const childSessionKey = "agent:main:subagent:restarted";
      const runs = [
        createRun({ runId: "legacy", childSessionKey, createdAt: 300, generation: 1 }),
        createRun({ runId: "latest", childSessionKey, createdAt: 100, generation: 2 }),
        createRun({ runId: "same-zulu", childSessionKey, createdAt: 200, generation: 2 }),
        createRun({ runId: "same-alpha", childSessionKey, createdAt: 200, generation: 2 }),
        createRun({ runId: "other", childSessionKey: "agent:main:subagent:other" }),
      ];
      saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));

      expect(
        loadSubagentRunsForChildSessionFromSqlite(childSessionKey).map((run) => run.runId),
      ).toEqual(["latest", "same-alpha", "same-zulu", "legacy"]);
      expect(loadSubagentRunsForChildSessionFromSqlite("   ")).toEqual([]);
    });
  });
});
