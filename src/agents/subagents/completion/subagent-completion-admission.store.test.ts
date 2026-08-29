import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  moveSessionDeliveryToFailed,
  prepareClaimedSessionDelivery,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
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
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  admitSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
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
  });

  function records() {
    const now = Date.now();
    const task: TaskRecord = {
      taskId: "task-completion",
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:child",
      runId: "task-run",
      task: "finish the work",
      status: "succeeded",
      deliveryStatus: "session_queued",
      terminalOutcome: "succeeded",
      notifyPolicy: "done_only",
      createdAt: now - 2_000,
      endedAt: now - 1_000,
      lastEventAt: now,
    };
    const subagent = createSubagentRunRecord({
      runId: "completion-run",
      taskRunId: task.runId,
      childSessionKey: task.childSessionKey,
      requesterSessionKey: task.requesterSessionKey,
      requesterDisplayKey: task.requesterSessionKey,
      task: task.task,
      createdAt: task.createdAt,
      endedAt: task.endedAt,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "canonical result", capturedAt: now },
      delivery: {
        status: "in_progress",
        disposition: "session_queued",
        generation: 1,
        queueId: "placeholder",
        windowStartedAt: now,
        deadlineAt: now + 30 * 60_000,
      },
    });
    const queueEntry = prepareClaimedSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: task.requesterSessionKey,
        message: "canonical result is loaded at delivery time",
        messageId: "completion:1",
        idempotencyKey: "completion:1",
        owner: {
          kind: "subagent_completion",
          runId: subagent.runId,
          taskId: task.taskId,
          generation: 1,
          deadlineAt: subagent.delivery?.deadlineAt ?? 0,
        },
      },
      125_000,
      now,
    );
    subagent.delivery!.queueId = queueEntry.id;
    return { queueEntry, subagent, task };
  }

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

  it("keeps canonical owner payload through failure and clears it after redrive success", async () => {
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

      await settleCorrelatedSubagentDelivery(secondEntry, "recovered");
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
      await expect(fs.stat(attachmentsDir)).resolves.toBeDefined();
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
