import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareClaimedSessionDelivery } from "../infra/session-delivery-queue.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  admitSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";

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
});
