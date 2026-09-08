import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { recoverPendingSessionDeliveries } from "../../../infra/session-delivery-queue-recovery.js";
import {
  moveSessionDeliveryToFailed,
  releaseSessionDeliveryClaim,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue-storage.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { ensureTaskRegistryReady, getTaskById } from "../../../tasks/runtime-internal.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { suspendPendingFinalDelivery } from "../registry/subagent-registry-lifecycle-cleanup.js";
import { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  admitSubagentCompletionDelivery,
  blockSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import {
  armRequesterWake,
  failedRecords,
  records,
  requesterWakeDriver,
} from "./subagent-completion-admission.test-helpers.js";
import {
  admitCorrelatedSubagentSessionDelivery,
  dismissSubagentCompletionDelivery,
  resolveCorrelatedSubagentDelivery,
  retrySubagentCompletionDelivery,
  settleCorrelatedSubagentDelivery,
} from "./subagent-completion-delivery.js";

const resumeSubagentRun = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const discardTerminalDelivery = (entry: SubagentRunRecord, completedAt: number) =>
  SubagentLifecycleController.discardTerminalDelivery(entry, completedAt);

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun }));

describe("atomic subagent completion admission store", () => {
  let tempDir: string;
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-subagent-admission-", resolvePreferredOpenClawTmpDir());
    database = openOpenClawStateDatabase({ path: path.join(tempDir, "state.sqlite") });
  });

  afterEach(() => {
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function rowCount(table: "delivery_queue_entries" | "subagent_runs" | "task_runs"): number {
    const row = database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  function clearRows(): void {
    database.db.exec(
      "DELETE FROM delivery_queue_entries; DELETE FROM subagent_runs; DELETE FROM task_runs;",
    );
  }

  function persistOwner(input = records()) {
    settleSubagentCompletionDelivery({
      subagent: input.subagent,
      task: input.task,
      databaseOptions: { database },
    });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
    return input;
  }

  function systemEvents() {
    return (
      database.db
        .prepare(
          "SELECT id, status, entry_json FROM delivery_queue_entries WHERE entry_kind = 'systemEvent' ORDER BY id",
        )
        .all() as Array<{ id: string; status: string; entry_json: string }>
    ).map((row) =>
      Object.assign(row, { entry: JSON.parse(row.entry_json) as Record<string, unknown> }),
    );
  }

  function resetOwners(): void {
    clearRows();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    database = openOpenClawStateDatabase({ path: path.join(tempDir, "state.sqlite") });
  }

  function useDefaultDatabase(): void {
    closeOpenClawStateDatabaseForTest();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
  }

  function reopenOwners() {
    closeOpenClawStateDatabaseForTest();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    database = openOpenClawStateDatabase();
    for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(runId, entry);
    }
    ensureTaskRegistryReady();
  }

  it.each([
    { name: "cancelled/error", status: "cancelled", outcome: { status: "error" } },
    { name: "failed/error", status: "failed", outcome: { status: "error" } },
    { name: "timed_out/timeout", status: "timed_out", outcome: { status: "timeout" } },
    { name: "cancelled/ok kill race", status: "cancelled", outcome: { status: "ok" } },
    { name: "failed/unknown", status: "failed", outcome: { status: "unknown" } },
  ] as const)(
    "durably settles a rejected $name wake without rewriting the child outcome",
    async ({ status, outcome }) => {
      useDefaultDatabase();
      const input = persistOwner(failedRecords(status, outcome));
      const originalTask = structuredClone(input.task);
      const originalExecution = structuredClone(input.subagent.execution);
      const driver = requesterWakeDriver([input]);
      try {
        await driver.run();
        expect(driver.warn).not.toHaveBeenCalledWith(
          "failed to persist requester settle wake rejection",
          expect.any(Object),
        );
        expect(input.subagent).toMatchObject({
          delivery: { status: "failed", lastError: "requester unavailable" },
          suppressCompletionDelivery: true,
        });
        expect(input.subagent.requesterSettleWake).toBeUndefined();
        expect(systemEvents()).toEqual([]);

        reopenOwners();
        const restored = subagentRuns.get(input.subagent.runId)!;
        expect(restored.requesterSettleWake).toBeUndefined();
        expect(restored.delivery).toMatchObject({
          status: "failed",
          lastError: "requester unavailable",
        });
        expect(restored.delivery?.queueId).toBeUndefined();
        expect(restored.delivery?.nextAttemptAt).toBeUndefined();
        expect(restored.execution).toEqual(originalExecution);
        expect(getTaskById(input.task.taskId)).toMatchObject({
          status: originalTask.status,
          deliveryStatus: "failed",
          error: originalTask.error,
          terminalSummary: originalTask.terminalSummary,
          cleanupAfter: originalTask.cleanupAfter,
          endedAt: originalTask.endedAt,
        });
        expect(getTaskById(input.task.taskId)?.terminalOutcome).toBeUndefined();

        const deliver = vi.fn(async () => {});
        await expect(
          recoverPendingSessionDeliveries({
            deliver,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          }),
        ).resolves.toMatchObject({ recovered: 0, failed: 0 });
        expect(deliver).not.toHaveBeenCalled();
        expect(driver.wake).toHaveBeenCalledOnce();
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it.each(["successful generation", "successful task run", "cancelled delivered"] as const)(
    "rejects a stale %s requester-settle owner without changing durable records",
    async (change) => {
      useDefaultDatabase();
      const input = persistOwner(
        change === "cancelled delivered"
          ? failedRecords("cancelled", { status: "error" })
          : armRequesterWake(records()),
      );
      const durable = structuredClone(input);
      if (change === "successful generation") {
        durable.subagent.delivery!.generation = 2;
      } else if (change === "successful task run") {
        durable.task.runId = "replacement-task-run";
      } else {
        durable.subagent.delivery!.status = "delivered";
        durable.subagent.delivery!.deliveredAt = Date.now();
        durable.task.deliveryStatus = "delivered";
      }
      // Leave the controller's in-memory row stale while the canonical owner advances.
      settleSubagentCompletionDelivery({
        subagent: durable.subagent,
        task: durable.task,
        databaseOptions: { database },
      });
      const driver = requesterWakeDriver([input]);
      try {
        await driver.run();
        expect(driver.warn).toHaveBeenCalledWith(
          "failed to persist requester settle wake rejection",
          expect.objectContaining({
            error: expect.objectContaining({
              message: expect.stringContaining(
                "subagent completion owner changed before settlement",
              ),
            }),
          }),
        );
        expect(systemEvents()).toEqual([]);
        reopenOwners();
        expect(subagentRuns.get(input.subagent.runId)).toEqual(durable.subagent);
        expect(getTaskById(input.task.taskId)).toMatchObject({
          runId: durable.task.runId,
          status: durable.task.status,
          deliveryStatus: durable.task.deliveryStatus,
        });
        expect(getTaskById(input.task.taskId)?.terminalOutcome).toBe(durable.task.terminalOutcome);
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it("rolls a non-success wake settlement back when its task write fails", async () => {
    useDefaultDatabase();
    const input = persistOwner(failedRecords("cancelled", { status: "error" }));
    const before = structuredClone(input);
    database.db.exec(
      "CREATE TEMP TRIGGER reject_nonsuccess_task AFTER UPDATE ON task_runs " +
        "BEGIN SELECT RAISE(ABORT, 'cut:nonsuccess-task'); END",
    );
    const driver = requesterWakeDriver([input]);
    try {
      await driver.run();
      expect(driver.warn).toHaveBeenCalledWith(
        "failed to persist requester settle wake rejection",
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining("cut:nonsuccess-task"),
          }),
        }),
      );
      expect(input.subagent).toEqual(before.subagent);
      expect(getTaskById(input.task.taskId)).toMatchObject(before.task);
      expect(systemEvents()).toEqual([]);
      database.db.exec("DROP TRIGGER reject_nonsuccess_task");
      reopenOwners();
      expect(subagentRuns.get(input.subagent.runId)).toEqual(before.subagent);
      expect(getTaskById(input.task.taskId)).toMatchObject(before.task);
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("does not suspend a cancelled completion as a blocked success", () => {
    useDefaultDatabase();
    const input = persistOwner(failedRecords("cancelled", { status: "error" }));
    expect(
      blockSubagentCompletionDelivery({
        subagent: input.subagent,
        taskId: input.task.taskId,
        reason: "requester unavailable",
        suspendedReason: "permanent_failure",
        databaseOptions: { database },
      }),
    ).toBe(false);
    expect(systemEvents()).toEqual([]);
    reopenOwners();
    expect(subagentRuns.get(input.subagent.runId)).toEqual(input.subagent);
    expect(getTaskById(input.task.taskId)).toMatchObject(input.task);
  });

  it.each([false, true])("settles a mixed batch with success first: %s", async (successFirst) => {
    useDefaultDatabase();
    const cancelled = failedRecords("cancelled", { status: "error" });
    const success = records();
    success.task.taskId = "task-success";
    success.task.runId = "successful-task-run";
    success.subagent.runId = "successful-completion";
    success.subagent.taskRunId = success.task.runId;
    const inputs = successFirst ? [success, cancelled] : [cancelled, success];
    const batchRunIds = inputs.map((input) => input.subagent.runId);
    for (const input of inputs) {
      armRequesterWake(input, batchRunIds);
      persistOwner(input);
    }
    const driver = requesterWakeDriver(inputs);
    try {
      await driver.run();
      expect(driver.warn).not.toHaveBeenCalledWith(
        "failed to persist requester settle wake rejection",
        expect.any(Object),
      );
      expect(systemEvents()).toHaveLength(1);
      reopenOwners();
      for (const input of inputs) {
        expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeUndefined();
        expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("failed");
      }
      expect(getTaskById(cancelled.task.taskId)).toMatchObject({
        status: "cancelled",
        deliveryStatus: "failed",
        error: cancelled.task.error,
      });
      expect(getTaskById(success.task.taskId)).toMatchObject({
        status: "succeeded",
        deliveryStatus: "failed",
        terminalOutcome: "blocked",
      });
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it.each(["queue", "subagent", "task"] as const)(
    "rolls every owner row back when the %s cut fails",
    (cut) => {
      const input = records();
      let bindObservedOutsideTransaction = false;
      expect(() =>
        admitSubagentCompletionDelivery({
          ...input,
          databaseOptions: { database },
          testHooks: {
            afterBind: () => {
              bindObservedOutsideTransaction = !database.db.isTransaction;
            },
            afterMutation: (phase, exactDatabase) => {
              expect(exactDatabase).toBe(database);
              expect(exactDatabase.db.isTransaction).toBe(true);
              if (phase === cut) {
                throw new Error(`cut:${cut}`);
              }
            },
          },
        }),
      ).toThrow(`cut:${cut}`);
      expect(bindObservedOutsideTransaction).toBe(true);
      expect(rowCount("delivery_queue_entries")).toBe(0);
      expect(rowCount("subagent_runs")).toBe(0);
      expect(rowCount("task_runs")).toBe(0);
      clearRows();
    },
  );

  it("commits one linked generation and rejects asynchronous transaction hooks", () => {
    const input = records();
    const phases: string[] = [];
    const first = admitSubagentCompletionDelivery({
      ...input,
      databaseOptions: { database },
      testHooks: {
        afterMutation: (phase, exactDatabase) => {
          expect(exactDatabase).toBe(database);
          expect(exactDatabase.db.isTransaction).toBe(true);
          phases.push(phase);
        },
      },
    });
    expect(first.claimed).toBe(true);
    expect(phases).toEqual(["queue", "subagent", "task"]);
    expect(rowCount("delivery_queue_entries")).toBe(1);
    expect(rowCount("subagent_runs")).toBe(1);
    expect(rowCount("task_runs")).toBe(1);

    const second = admitSubagentCompletionDelivery({
      ...input,
      databaseOptions: { database },
    });
    expect(second.claimed).toBe(false);
    expect(rowCount("delivery_queue_entries")).toBe(1);

    const settledSubagent: SubagentRunRecord = structuredClone(input.subagent);
    settledSubagent.delivery!.status = "delivered";
    settledSubagent.delivery!.disposition = "delivered";
    const settledTask: TaskRecord = {
      ...input.task,
      deliveryStatus: "delivered",
    };
    settleSubagentCompletionDelivery({
      subagent: settledSubagent,
      task: settledTask,
      databaseOptions: { database },
    });
    const storedTask = database.db
      .prepare("SELECT delivery_status FROM task_runs WHERE task_id = ?")
      .get(input.task.taskId) as { delivery_status: string };
    expect(storedTask.delivery_status).toBe("delivered");

    clearRows();
    expect(() =>
      admitSubagentCompletionDelivery({
        ...records(),
        databaseOptions: { database },
        testHooks: { afterMutation: async () => undefined },
      }),
    ).toThrow("transaction hooks must be synchronous");
    expect(rowCount("delivery_queue_entries")).toBe(0);
    expect(rowCount("subagent_runs")).toBe(0);
    expect(rowCount("task_runs")).toBe(0);
  });

  it.each(["queue", "subagent", "task"] as const)(
    "rolls blocked state and its durable alert back after the %s mutation",
    (cut) => {
      const input = persistOwner();
      const table =
        cut === "queue"
          ? "delivery_queue_entries"
          : cut === "subagent"
            ? "subagent_runs"
            : "task_runs";
      database.db.exec(`
        CREATE TRIGGER fail_blocked_${cut}
        AFTER ${cut === "queue" ? "INSERT" : "UPDATE"} ON ${table}
        BEGIN
          SELECT RAISE(ABORT, 'cut:${cut}');
        END;
      `);

      expect(() =>
        blockSubagentCompletionDelivery({
          subagent: input.subagent,
          taskId: input.task.taskId,
          reason: "requester unavailable",
          suspendedReason: "permanent_failure",
          databaseOptions: { database },
        }),
      ).toThrow(`cut:${cut}`);
      expect(systemEvents()).toEqual([]);
      expect(
        JSON.parse(
          (
            database.db
              .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
              .get(input.subagent.runId) as { payload_json: string }
          ).payload_json,
        ),
      ).toMatchObject({ delivery: { status: "in_progress", queueId: input.queueEntry.id } });
      expect(
        database.db
          .prepare("SELECT delivery_status, terminal_outcome FROM task_runs WHERE task_id = ?")
          .get(input.task.taskId),
      ).toMatchObject({ delivery_status: "session_queued", terminal_outcome: "succeeded" });
      database.db.exec(`DROP TRIGGER fail_blocked_${cut}`);
      resetOwners();
    },
  );

  it("routes and deduplicates one blocked alert per completion generation", async () => {
    const input = records();
    input.task.requesterSessionKey = "agent:main:cron:job-1:run:abc:subagent:child";
    input.task.ownerKey = input.task.requesterSessionKey;
    input.subagent.requesterSessionKey = input.task.requesterSessionKey;
    input.subagent.requesterDisplayKey = input.task.requesterSessionKey;
    persistOwner(input);

    const block = () =>
      blockSubagentCompletionDelivery({
        subagent: input.subagent,
        taskId: input.task.taskId,
        reason: "requester unavailable",
        suspendedReason: "permanent_failure",
        databaseOptions: { database },
      });
    expect(block()).toBe(true);
    expect(block()).toBe(true);
    expect(systemEvents()).toHaveLength(1);
    expect(systemEvents()[0]?.entry).toMatchObject({
      kind: "systemEvent",
      sessionKey: "agent:main:main",
      agentId: "main",
      deliveryContext: {
        channel: "discord",
        to: "channel:requester",
        accountId: "primary",
      },
    });
    expect(getTaskById(input.task.taskId)).toMatchObject({
      deliveryStatus: "failed",
      terminalOutcome: "blocked",
    });
    expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
      status: "suspended",
      disposition: "permanent_failure",
    });
    const storedSubagent = JSON.parse(
      (
        database.db
          .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
          .get(input.subagent.runId) as { payload_json: string }
      ).payload_json,
    );
    expect(storedSubagent.requesterSettleWake).toEqual({ status: "pending", attemptCount: 0 });

    await expect(
      retrySubagentCompletionDelivery(input.task.taskId, { database }),
    ).resolves.toMatchObject({ ok: true });
    expect(block()).toBe(true);
    expect(new Set(systemEvents().map((event) => event.id)).size).toBe(2);

    resetOwners();
    const global = records();
    global.task.requesterSessionKey = "global";
    global.task.ownerKey = "global";
    global.subagent.requesterSessionKey = "global";
    global.subagent.requesterDisplayKey = "global";
    persistOwner(global);
    expect(
      blockSubagentCompletionDelivery({
        subagent: global.subagent,
        taskId: global.task.taskId,
        reason: "requester unavailable",
        suspendedReason: "expiry",
        databaseOptions: { database },
      }),
    ).toBe(true);
    expect(systemEvents()[0]?.entry).toMatchObject({
      kind: "systemEvent",
      sessionKey: "global",
      agentId: "main",
    });

    resetOwners();
    const silent = records();
    silent.task.notifyPolicy = "silent";
    persistOwner(silent);
    expect(
      blockSubagentCompletionDelivery({
        subagent: silent.subagent,
        taskId: silent.task.taskId,
        reason: "requester unavailable",
        suspendedReason: "expiry",
        databaseOptions: { database },
      }),
    ).toBe(true);
    expect(systemEvents()).toEqual([]);
  });

  it("persists requester-settle suppression with a non-suspended block", () => {
    const input = persistOwner();
    expect(
      blockSubagentCompletionDelivery({
        subagent: input.subagent,
        taskId: input.task.taskId,
        reason: "requester settle wake failed",
        databaseOptions: { database },
      }),
    ).toBe(true);
    expect(subagentRuns.get(input.subagent.runId)).toMatchObject({
      delivery: { status: "failed" },
      suppressCompletionDelivery: true,
    });
  });

  it("uses the same blocked intent for ordinary and correlated exhaustion", async () => {
    useDefaultDatabase();
    const ordinary = persistOwner();
    suspendPendingFinalDelivery(
      {
        options: {
          runs: subagentRuns,
          resumedRuns: new Set<string>(),
          resolveSubagentTask: () => ({ lookup: "available", task: ordinary.task }),
        },
        hasScheduledRequesterSettleWakeRun: () => true,
      } as unknown as Parameters<typeof suspendPendingFinalDelivery>[0],
      {
        runId: ordinary.subagent.runId,
        entry: ordinary.subagent,
        reason: "permanent_failure",
        error: "requester unavailable",
      },
    );
    const ordinaryId = systemEvents()[0]?.id;

    resetOwners();
    useDefaultDatabase();
    const correlated = persistOwner();
    await settleCorrelatedSubagentDelivery(correlated.queueEntry, "moved-to-failed");
    expect(systemEvents()).toHaveLength(1);
    expect(systemEvents()[0]?.id).toBe(ordinaryId);
  });

  it("recovers a committed blocked alert once and leaves a completed tombstone", async () => {
    useDefaultDatabase();
    const input = persistOwner();
    expect(
      blockSubagentCompletionDelivery({
        subagent: input.subagent,
        taskId: input.task.taskId,
        reason: "requester unavailable",
        suspendedReason: "permanent_failure",
        databaseOptions: { database },
      }),
    ).toBe(true);
    const queueId = systemEvents()[0]?.id;
    if (!queueId) {
      throw new Error("blocked alert was not queued");
    }
    const deliver = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(recoverPendingSessionDeliveries({ deliver, log })).resolves.toMatchObject({
      recovered: 1,
    });
    await expect(recoverPendingSessionDeliveries({ deliver, log })).resolves.toMatchObject({
      recovered: 0,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(
      database.db
        .prepare("SELECT status FROM delivery_queue_entries WHERE id = ?")
        .get(queueId) as { status: string },
    ).toEqual({ status: "completed" });
  });

  it("dead-letters expired orphan generations before resolving their logical owner", () => {
    const { queueEntry } = records();
    if (queueEntry.kind !== "agentTurn" || queueEntry.owner?.kind !== "subagent_completion") {
      throw new Error("expected correlated subagent completion queue entry");
    }
    queueEntry.owner.deadlineAt = Date.now() - 1;

    expect(() => resolveCorrelatedSubagentDelivery(queueEntry)).toThrow(
      SessionDeliveryDeadLetteredError,
    );
  });

  it("defers an unexpired generation whose logical owner has moved on", () => {
    const { queueEntry, subagent } = records();
    subagent.delivery!.generation = 2;
    subagentRuns.set(subagent.runId, subagent);

    expect(() => resolveCorrelatedSubagentDelivery(queueEntry)).toThrow(
      SessionDeliveryDeferredError,
    );
  });

  it("recovers canonical completion guidance after restart and clears payload after redrive success", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase();
      const input = records();
      input.subagent.delivery = {
        status: "pending",
        generation: 1,
        windowStartedAt: Date.now(),
        deadlineAt: Date.now() + 30 * 60_000,
      };
      input.task.deliveryStatus = "pending";
      subagentRuns.set(input.subagent.runId, input.subagent);
      ensureTaskRegistryReady();
      publishTaskRecordAfterAtomicStore(input.task);
      const payload = {
        kind: "agentTurn" as const,
        sessionKey: input.task.requesterSessionKey,
        message: "placeholder",
        messageId: "completion-owner-state",
        idempotencyKey: "completion-owner-state",
        route: {
          channel: "discord",
          to: "channel:requester",
          accountId: "primary",
          chatType: "channel" as const,
        },
        expectedMediaUrls: ["https://example.com/result.png"],
      };

      const first = admitCorrelatedSubagentSessionDelivery({
        runId: input.subagent.runId,
        payload,
      });
      expect(first).toMatchObject({ claimed: true, status: "pending" });
      expect(subagentRuns.get(input.subagent.runId)?.delivery?.payload).toMatchObject({
        childRunId: input.subagent.runId,
        task: input.subagent.task,
      });
      const firstQueue = database.db
        .prepare("SELECT entry_json FROM delivery_queue_entries WHERE id = ?")
        .get(first.id) as { entry_json: string };
      expect(JSON.parse(firstQueue.entry_json)).toMatchObject({
        retainOnFailure: true,
        messageId: payload.messageId,
      });

      const queued = JSON.parse(firstQueue.entry_json) as ReturnType<typeof records>["queueEntry"];
      await settleCorrelatedSubagentDelivery(queued, "moved-to-failed");
      expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
        status: "suspended",
        queueId: undefined,
        payload: expect.objectContaining({ childRunId: input.subagent.runId }),
      });
      await moveSessionDeliveryToFailed(first.id, tempDir);

      await expect(
        retrySubagentCompletionDelivery(input.task.taskId, { database }),
      ).resolves.toMatchObject({
        ok: true,
        duplicateRisk: true,
      });
      const second = admitCorrelatedSubagentSessionDelivery({
        runId: input.subagent.runId,
        payload,
      });
      expect(second.id).not.toBe(first.id);
      const secondQueue = database.db
        .prepare("SELECT entry_json FROM delivery_queue_entries WHERE id = ?")
        .get(second.id) as { entry_json: string };
      const secondEntry = JSON.parse(secondQueue.entry_json) as ReturnType<
        typeof records
      >["queueEntry"];
      expect(secondEntry).toMatchObject({
        messageId: `${payload.messageId}:generation:2`,
        retainOnFailure: true,
      });

      await releaseSessionDeliveryClaim(second.id);
      resetTaskRegistryForTests({ persist: false });
      subagentRuns.clear();
      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase();
      for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
        subagentRuns.set(runId, entry);
      }
      ensureTaskRegistryReady();

      const delivered: QueuedSessionDelivery[] = [];
      const deliver = vi.fn(async (entry: QueuedSessionDelivery) => {
        delivered.push(resolveCorrelatedSubagentDelivery(entry));
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const onSettled = vi.fn(settleCorrelatedSubagentDelivery);
      await expect(
        recoverPendingSessionDeliveries({ deliver, log, onSettled }),
      ).resolves.toMatchObject({ recovered: 2, failed: 0 });
      const recovered = delivered.find((entry) => entry.id === second.id);
      expect(recovered).toMatchObject({
        kind: "agentTurn",
        sessionKey: payload.sessionKey,
        route: payload.route,
        expectedMediaUrls: payload.expectedMediaUrls,
        message: expect.stringContaining("canonical result"),
      });
      if (recovered?.kind !== "agentTurn" || secondEntry.kind !== "agentTurn") {
        throw new Error("correlated completion changed queue entry kind");
      }
      for (const message of [recovered.message, secondEntry.message]) {
        expect(message).toContain("This completion ends one child run");
        expect(message).toContain("Compare the result with the requested outcome");
        expect(message).toContain("in-scope fixable blockers require continued work");
        expect(message).toContain("new user authority or an unavailable external decision");
      }
      await expect(
        recoverPendingSessionDeliveries({ deliver, log, onSettled }),
      ).resolves.toMatchObject({ recovered: 0 });
      expect(delivered.filter((entry) => entry.id === second.id)).toHaveLength(1);
      expect(onSettled.mock.calls.filter(([entry]) => entry.id === second.id)).toHaveLength(1);
      expect(
        database.db
          .prepare("SELECT status FROM delivery_queue_entries WHERE id = ?")
          .get(second.id),
      ).toEqual({ status: "completed" });
      expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
        status: "delivered",
        queueId: undefined,
        payload: undefined,
      });
    });
  });

  it("reloads a blocked text completion from SQLite before canonical owner redrive", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase();
      const input = records();
      const now = Date.now();
      input.subagent.delivery = {
        status: "suspended",
        disposition: "permanent_failure",
        generation: 1,
        windowStartedAt: now - 31 * 60_000,
        deadlineAt: now - 60_000,
        suspendedAt: now,
        suspendedReason: "expiry",
        lastError: "requester unavailable",
        payload: {
          requesterSessionKey: input.task.requesterSessionKey,
          requesterDisplayKey: input.subagent.requesterDisplayKey,
          childSessionKey: input.subagent.childSessionKey,
          childRunId: input.subagent.runId,
          task: input.task.task,
          endedAt: input.task.endedAt,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
        },
      };
      input.task.deliveryStatus = "failed";
      input.task.terminalOutcome = "blocked";
      input.task.error = "requester unavailable";
      input.task.terminalSummary = "Task completed, but result delivery is blocked.";
      input.task.cleanupAfter = now + 7 * 24 * 60 * 60_000;
      input.subagent.completion = {
        required: true,
        resultText: "NO_REPLY",
        fallbackResultText: "canonical result",
        capturedAt: now,
      };
      settleSubagentCompletionDelivery({ ...input, databaseOptions: { database } });

      const legacyRow = database.db
        .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
        .get(input.subagent.runId) as { payload_json: string };
      const legacyPayload = JSON.parse(legacyRow.payload_json) as SubagentRunRecord;
      legacyPayload.delivery!.payload = {
        ...legacyPayload.delivery!.payload!,
        frozenResultText: legacyPayload.completion?.resultText,
        fallbackFrozenResultText: legacyPayload.completion?.fallbackResultText,
      } as NonNullable<SubagentRunRecord["delivery"]>["payload"] & {
        frozenResultText: string | null | undefined;
        fallbackFrozenResultText: string | null | undefined;
      };
      delete legacyPayload.completion!.fallbackResultText;
      database.db
        .prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?")
        .run(JSON.stringify(legacyPayload), input.subagent.runId);
      database.db
        .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
        .run("2026.7.0");

      resetTaskRegistryForTests({ persist: false });
      subagentRuns.clear();
      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase();
      for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
        subagentRuns.set(runId, entry);
      }
      ensureTaskRegistryReady();
      expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
        status: "suspended",
        disposition: "permanent_failure",
        generation: 1,
        suspendedReason: "expiry",
      });
      expect(subagentRuns.get(input.subagent.runId)?.completion).toMatchObject({
        resultText: "NO_REPLY",
        fallbackResultText: "canonical result",
      });
      expect(subagentRuns.get(input.subagent.runId)?.delivery?.payload).not.toHaveProperty(
        "frozenResultText",
      );
      expect(getTaskById(input.task.taskId)).toMatchObject({
        deliveryStatus: "failed",
        terminalOutcome: "blocked",
        cleanupAfter: input.task.cleanupAfter,
        progressSummary: "canonical result",
      });

      const result = await retrySubagentCompletionDelivery(input.task.taskId, { database });

      expect(result.reason).toBeUndefined();
      expect(result).toMatchObject({ ok: true, duplicateRisk: true });
      expect(resumeSubagentRun).toHaveBeenCalledWith(input.subagent.runId);
      expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
        status: "pending",
        disposition: "retryable",
        generation: 2,
        attemptCount: 0,
      });
      expect(result.task).toMatchObject({
        deliveryStatus: "pending",
        terminalOutcome: "succeeded",
        progressSummary: "canonical result",
      });
      expect(result.task?.error).toBeUndefined();
      expect(result.task?.terminalSummary).toBeUndefined();
      const redriven = subagentRuns.get(input.subagent.runId)!;
      redriven.delivery!.queueId = "queue-proof";
      const resolvedQueueEntry = resolveCorrelatedSubagentDelivery({
        id: "queue-proof",
        kind: "agentTurn",
        sessionKey: input.task.requesterSessionKey,
        message: "placeholder",
        messageId: "queue-proof",
        enqueuedAt: now,
        retryCount: 0,
        owner: {
          kind: "subagent_completion",
          runId: redriven.runId,
          taskId: input.task.taskId,
          generation: redriven.delivery!.generation!,
          deadlineAt: redriven.delivery!.deadlineAt!,
        },
      });
      expect(resolvedQueueEntry.kind).toBe("agentTurn");
      if (resolvedQueueEntry.kind !== "agentTurn") {
        throw new Error("correlated completion changed queue entry kind");
      }
      expect(resolvedQueueEntry.message).toContain("canonical result");
      redriven.delivery!.queueId = undefined;
      const persisted = database.db
        .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
        .get(input.subagent.runId) as { payload_json: string };
      expect(JSON.parse(persisted.payload_json).delivery).toMatchObject({
        status: "pending",
        generation: 2,
      });

      const cappedSubagent = structuredClone(subagentRuns.get(input.subagent.runId)!);
      const attachmentsRootDir = path.join(tempDir, "attachments");
      const attachmentsDir = path.join(attachmentsRootDir, "completion-run");
      await fs.mkdir(attachmentsDir, { recursive: true });
      await fs.writeFile(path.join(attachmentsDir, "result.txt"), "retained result");
      cappedSubagent.attachmentsRootDir = attachmentsRootDir;
      cappedSubagent.attachmentsDir = attachmentsDir;
      Object.assign(cappedSubagent.delivery!, {
        status: "suspended",
        generation: 10,
        suspendedAt: now,
        suspendedReason: "expiry",
      });
      const cappedTask: TaskRecord = {
        ...result.task!,
        deliveryStatus: "failed",
        terminalOutcome: "blocked",
      };
      settleSubagentCompletionDelivery({
        subagent: cappedSubagent,
        task: cappedTask,
        databaseOptions: { database },
      });
      subagentRuns.set(cappedSubagent.runId, cappedSubagent);
      publishTaskRecordAfterAtomicStore(cappedTask);
      resumeSubagentRun.mockClear();

      await expect(
        retrySubagentCompletionDelivery(input.task.taskId, { database }),
      ).resolves.toEqual({
        ok: false,
        reason: "completion delivery redrive limit reached",
      });
      expect(resumeSubagentRun).not.toHaveBeenCalled();
      const discardInsideTransaction = vi.fn((entry: SubagentRunRecord, completedAt: number) => {
        expect(database.db.isTransaction).toBe(true);
        discardTerminalDelivery(entry, completedAt);
      });
      database.db.exec(`
        CREATE TRIGGER fail_dismissed_task_persist
        BEFORE UPDATE ON task_runs
        BEGIN
          SELECT RAISE(ABORT, 'injected dismissal persistence failure');
        END;
      `);

      await expect(
        dismissSubagentCompletionDelivery(input.task.taskId, {
          discardTerminalDelivery: discardInsideTransaction,
          databaseOptions: { database },
        }),
      ).rejects.toThrow("injected dismissal persistence failure");
      expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("suspended");
      expect(getTaskById(input.task.taskId)?.deliveryStatus).toBe("failed");
      const rolledBackSubagent = database.db
        .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
        .get(input.subagent.runId) as { payload_json: string };
      expect(JSON.parse(rolledBackSubagent.payload_json).delivery.status).toBe("suspended");
      const rolledBackTask = database.db
        .prepare("SELECT delivery_status FROM task_runs WHERE task_id = ?")
        .get(input.task.taskId) as { delivery_status: string };
      expect(rolledBackTask.delivery_status).toBe("failed");
      await expect(fs.stat(attachmentsDir)).resolves.toBeDefined();
      database.db.exec("DROP TRIGGER fail_dismissed_task_persist");

      const dismissed = await dismissSubagentCompletionDelivery(input.task.taskId, {
        discardTerminalDelivery: discardInsideTransaction,
        databaseOptions: { database },
      });
      expect(discardInsideTransaction).toHaveBeenCalledTimes(2);
      await expect(fs.stat(attachmentsDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(dismissed).toMatchObject({
        ok: true,
        task: {
          deliveryStatus: "dismissed",
          terminalOutcome: "blocked",
          progressSummary: "canonical result",
        },
      });
      expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
        status: "discarded",
        disposition: "intentional_non_delivery",
        payload: undefined,
        suspendedAt: undefined,
        suspendedReason: undefined,
      });
      expect(subagentRuns.get(input.subagent.runId)?.cleanupCompletedAt).toBeTypeOf("number");

      resetTaskRegistryForTests({ persist: false });
      subagentRuns.clear();
      for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
        subagentRuns.set(runId, entry);
      }
      ensureTaskRegistryReady();
      expect(getTaskById(input.task.taskId)).toMatchObject({
        deliveryStatus: "dismissed",
        terminalOutcome: "blocked",
        progressSummary: "canonical result",
      });
      expect(subagentRuns.get(input.subagent.runId)).toMatchObject({
        cleanupHandled: true,
        cleanupCompletedAt: expect.any(Number),
        delivery: {
          status: "discarded",
          disposition: "intentional_non_delivery",
        },
      });
      expect(subagentRuns.get(input.subagent.runId)?.delivery).not.toHaveProperty("payload");
    });
  });
});
