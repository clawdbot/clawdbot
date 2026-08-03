import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareClaimedSessionDelivery } from "../infra/session-delivery-queue.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { ensureTaskRegistryReady, getTaskById } from "../tasks/runtime-internal.js";
import { publishTaskRecordAfterAtomicStore } from "../tasks/task-registry.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import {
  admitSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import { retrySubagentCompletionDelivery } from "./subagent-completion-delivery.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";

const resumeSubagentRun = vi.hoisted(() => vi.fn());

vi.mock("./subagent-registry.js", () => ({ resumeSubagentRun }));

describe("atomic subagent completion admission store", () => {
  let tempDir: string;
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-subagent-admission-"),
    );
    database = openOpenClawStateDatabase({ path: path.join(tempDir, "state.sqlite") });
  });

  afterEach(() => {
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
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

  it("redrives an ordinary text completion through its retained registry owner", async () => {
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
    settleSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
    expect(getTaskById(input.task.taskId)).toBeDefined();

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
    const persisted = database.db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get(input.subagent.runId) as { payload_json: string };
    expect(JSON.parse(persisted.payload_json).delivery).toMatchObject({
      status: "pending",
      generation: 2,
    });

    const cappedSubagent = structuredClone(subagentRuns.get(input.subagent.runId)!);
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

    await expect(retrySubagentCompletionDelivery(input.task.taskId, { database })).resolves.toEqual(
      {
        ok: false,
        reason: "completion delivery redrive limit reached",
      },
    );
    expect(resumeSubagentRun).not.toHaveBeenCalled();
  });
});
