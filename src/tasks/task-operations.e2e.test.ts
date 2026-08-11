import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTasksCommand } from "../auto-reply/reply/commands-tasks.js";
import {
  baseCommandTestConfig,
  buildCommandTestParams,
} from "../auto-reply/reply/commands.test-harness.js";
import {
  tasksAuditCommand,
  tasksCancelCommand,
  tasksListCommand,
  tasksMaintenanceCommand,
  tasksNotifyCommand,
  tasksShowCommand,
} from "../commands/tasks.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRunningTaskRunCore, recordTaskRunProgressByRunIdCore } from "./task-executor.js";
import { createTaskRecord, getTaskById, reloadTaskRegistryFromStore } from "./task-registry.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const OWNER_KEY = "agent:main:main";
const DAY_MS = 24 * 60 * 60_000;

type CapturedRuntime = {
  runtime: RuntimeEnv;
  logs: string[];
  errors: string[];
  exits: number[];
};

function createRuntime(): CapturedRuntime {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    runtime: {
      log: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => errors.push(String(message)),
      exit: (code: number) => exits.push(code),
    } as RuntimeEnv,
    logs,
    errors,
    exits,
  };
}

function readJsonLog(capture: CapturedRuntime): unknown {
  const first = capture.logs[0];
  if (!first) {
    throw new Error("expected JSON command output");
  }
  return JSON.parse(first) as unknown;
}

function requireTask(taskId: string) {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error(`expected task ${taskId}`);
  }
  return task;
}

function resetTaskOperationsRuntime(): void {
  stopTaskRegistryMaintenance();
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryControlRuntimeForTests();
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetSystemEventsForTest();
  resetConfigRuntimeState();
  closeOpenClawAgentDatabasesForTest();
}

describe("task operations product boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetTaskOperationsRuntime();
  });

  it("runs persisted task operations through CLI, chat, notification, audit, and maintenance", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        scenario: "minimal",
        prefix: "openclaw-task-operations-e2e-",
      },
      async () => {
        resetTaskOperationsRuntime();
        const clearHeartbeat = setHeartbeatWakeHandler(async () => ({
          status: "ran",
          durationMs: 0,
        }));

        try {
          const now = Date.now();
          vi.useFakeTimers();
          vi.setSystemTime(now - 8 * DAY_MS);
          const expired = createTaskRecord({
            runtime: "cli",
            requesterSessionKey: OWNER_KEY,
            runId: "run-a07-expired",
            label: "Expired task",
            task: "Old completed task",
            status: "succeeded",
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
          });
          vi.setSystemTime(now - 40 * 60_000);
          const stale = createRunningTaskRunCore({
            runtime: "cli",
            requesterSessionKey: OWNER_KEY,
            runId: "run-a07-stale",
            label: "Stale task",
            task: "Task awaiting maintenance",
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
          });
          vi.setSystemTime(now);
          vi.useRealTimers();

          const operatorTask = createRunningTaskRunCore({
            runtime: "cli",
            requesterSessionKey: OWNER_KEY,
            runId: "run-a07-operator",
            label: "Operator lifecycle",
            task: "Process queued records",
            deliveryStatus: "pending",
            notifyPolicy: "done_only",
            progressSummary: "Starting work",
          });
          expect(expired).not.toBeNull();
          expect(stale).not.toBeNull();
          expect(operatorTask).not.toBeNull();
          if (!expired || !stale || !operatorTask) {
            throw new Error("expected task creation to succeed");
          }

          resetTaskRegistryForTests({ persist: false });
          reloadTaskRegistryFromStore();
          expect(requireTask(operatorTask.taskId)).toMatchObject({
            runId: "run-a07-operator",
            status: "running",
            notifyPolicy: "done_only",
          });

          const list = createRuntime();
          await tasksListCommand({}, list.runtime);
          expect(list.logs.join("\n")).toContain("Background tasks: 3");
          expect(list.logs.join("\n")).toContain("Task pressure: 0 queued · 1 running · 1 issues");
          expect(list.logs.join("\n")).toContain("Starting work");

          const show = createRuntime();
          await tasksShowCommand({ lookup: operatorTask.taskId }, show.runtime);
          expect(show.logs.join("\n")).toContain(`taskId: ${operatorTask.taskId}`);
          expect(show.logs.join("\n")).toContain("status: running");
          expect(show.logs.join("\n")).toContain("notify: done_only");

          const commandParams = buildCommandTestParams("/tasks", baseCommandTestConfig);
          const chatResult = await handleTasksCommand(commandParams, true);
          expect(chatResult?.reply?.text).toContain("Current session: 2 active · 2 total");
          expect(chatResult?.reply?.text).toContain("Operator lifecycle");
          expect(chatResult?.reply?.text).toContain("Stale task");

          const notify = createRuntime();
          await tasksNotifyCommand(
            { lookup: operatorTask.taskId, notify: "state_changes" },
            notify.runtime,
          );
          expect(notify.logs).toEqual([
            `Updated ${operatorTask.taskId} notify policy to state_changes.`,
          ]);
          expect(requireTask(operatorTask.taskId).notifyPolicy).toBe("state_changes");

          recordTaskRunProgressByRunIdCore({
            runId: "run-a07-operator",
            progressSummary: "Indexed 3 records",
            eventSummary: "Indexed 3 records",
          });
          await vi.waitFor(() => {
            expect(peekSystemEvents(OWNER_KEY)).toContain(
              "Background task update: Operator lifecycle. Indexed 3 records",
            );
          });

          resetTaskRegistryForTests({ persist: false });
          reloadTaskRegistryFromStore();
          expect(requireTask(operatorTask.taskId)).toMatchObject({
            notifyPolicy: "state_changes",
            progressSummary: "Indexed 3 records",
          });

          const audit = createRuntime();
          await tasksAuditCommand({ json: true }, audit.runtime);
          const auditPayload = readJsonLog(audit) as {
            summary: { byCode: { lost: number }; combined: { total: number } };
            findings: Array<{ kind: string; code: string; token?: string }>;
          };
          expect(auditPayload.summary.byCode.lost).toBe(1);
          expect(auditPayload.summary.combined.total).toBeGreaterThanOrEqual(1);
          expect(auditPayload.findings).toContainEqual(
            expect.objectContaining({
              kind: "task",
              code: "lost",
              token: stale.taskId,
            }),
          );

          const preview = createRuntime();
          await tasksMaintenanceCommand({ json: true, apply: false }, preview.runtime);
          const previewPayload = readJsonLog(preview) as {
            mode: string;
            maintenance: {
              tasks: { reconciled: number; pruned: number };
            };
          };
          expect(previewPayload.mode).toBe("preview");
          expect(previewPayload.maintenance.tasks).toMatchObject({
            reconciled: 1,
            pruned: 1,
          });

          const maintenance = createRuntime();
          await tasksMaintenanceCommand({ json: true, apply: true }, maintenance.runtime);
          const maintenancePayload = readJsonLog(maintenance) as {
            mode: string;
            maintenance: {
              tasks: { reconciled: number; pruned: number };
            };
            tasks: { byStatus: { lost: number } };
          };
          expect(maintenancePayload.mode).toBe("apply");
          expect(maintenancePayload.maintenance.tasks).toMatchObject({
            reconciled: 1,
            pruned: 1,
          });
          expect(maintenancePayload.tasks.byStatus.lost).toBe(1);
          expect(requireTask(stale.taskId).status).toBe("lost");
          expect(getTaskById(expired.taskId)).toBeUndefined();

          const cancel = createRuntime();
          await tasksCancelCommand({ lookup: operatorTask.taskId }, cancel.runtime);
          expect(cancel.errors).toEqual([]);
          expect(cancel.exits).toEqual([]);
          expect(cancel.logs).toEqual([
            `Cancelled ${operatorTask.taskId} (cli) run run-a07-operator.`,
          ]);
          expect(requireTask(operatorTask.taskId)).toMatchObject({
            status: "cancelled",
            error: "Cancelled by operator.",
          });

          const cancelledShow = createRuntime();
          await tasksShowCommand({ lookup: operatorTask.taskId }, cancelledShow.runtime);
          expect(cancelledShow.logs.join("\n")).toContain("status: cancelled");
        } finally {
          clearHeartbeat();
          resetTaskOperationsRuntime();
        }
      },
    );
  });
});
