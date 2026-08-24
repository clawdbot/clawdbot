// Tasks command tests cover filter rejection before registry queries.
import { describe, expect, it, vi } from "vitest";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import type { RuntimeEnv } from "../runtime.js";
import * as taskRegistryMaintenance from "../tasks/task-registry.maintenance.js";
import * as taskRegistryReconcile from "../tasks/task-registry.reconcile.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type {
  TaskSystemAuditCode,
  TaskSystemAuditSeverity,
} from "../tasks/task-system-audit.types.js";
import { tasksAuditCommand, tasksListCommand } from "./tasks.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("tasks command filter validation", () => {
  it("keeps valid matching and empty filters successful", async () => {
    const task: TaskRecord = {
      taskId: "task-1",
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Inspect filters",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
    };
    const query = vi
      .spyOn(taskRegistryReconcile, "reconcileInspectableTasks")
      .mockReturnValue([task]);
    const matchingRuntime = createRuntime();
    const emptyRuntime = createRuntime();

    try {
      await tasksListCommand({ json: true, status: "running" }, matchingRuntime);
      await tasksListCommand({ json: true, runtime: "cron" }, emptyRuntime);

      expect(JSON.parse(String(vi.mocked(matchingRuntime.log).mock.calls[0]?.[0]))).toStrictEqual({
        count: 1,
        runtime: null,
        status: "running",
        tasks: [task],
      });
      expect(JSON.parse(String(vi.mocked(emptyRuntime.log).mock.calls[0]?.[0]))).toStrictEqual({
        count: 0,
        runtime: "cron",
        status: null,
        tasks: [],
      });
    } finally {
      query.mockRestore();
    }
  });

  it.each([
    {
      options: { runtime: "bogus" },
      message: "--runtime must be subagent, acp, cron, or cli.",
    },
    {
      options: { status: "bogus" },
      message:
        "--status must be queued, running, succeeded, failed, timed_out, cancelled, or lost.",
    },
    {
      options: { status: "RUNNING" },
      message:
        "--status must be queued, running, succeeded, failed, timed_out, cancelled, or lost.",
    },
  ])("rejects invalid task list filters before querying", async ({ options, message }) => {
    const query = vi
      .spyOn(taskRegistryReconcile, "reconcileInspectableTasks")
      .mockImplementation(() => {
        throw new Error("task query performed");
      });
    const runtime = createRuntime();

    try {
      await runCommandWithRuntime(runtime, () => tasksListCommand(options, runtime));

      expect(runtime.error).toHaveBeenCalledWith(message);
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });

  it.each([
    {
      options: { severity: "bogus" as TaskSystemAuditSeverity },
      message: "--severity must be warn or error.",
    },
    {
      options: { code: "bogus-code" as TaskSystemAuditCode },
      message:
        "--code must be stale_queued, stale_running, lost, delivery_failed, missing_cleanup, inconsistent_timestamps, restore_failed, stale_waiting, stale_blocked, cancel_stuck, missing_linked_tasks, or blocked_task_missing.",
    },
  ])("rejects invalid task audit filters before querying", async ({ options, message }) => {
    const query = vi
      .spyOn(taskRegistryMaintenance, "configureTaskRegistryMaintenance")
      .mockImplementation(() => {
        throw new Error("task audit query performed");
      });
    const runtime = createRuntime();

    try {
      await runCommandWithRuntime(runtime, () => tasksAuditCommand(options, runtime));

      expect(runtime.error).toHaveBeenCalledWith(message);
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });
});
