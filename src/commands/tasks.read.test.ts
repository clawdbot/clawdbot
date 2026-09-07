// Tasks command tests cover read-only list output and filter rejection before registry queries.
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
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
        "--status must be queued, running, succeeded, failed, timed_out, cancelled, lost, or blocked.",
    },
    {
      options: { status: "RUNNING" },
      message:
        "--status must be queued, running, succeeded, failed, timed_out, cancelled, lost, or blocked.",
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

describe("tasks list output", () => {
  afterEach(() => {
    mocks.callGateway.mockReset();
  });

  it.each([
    {
      name: "ASCII cells and their headings",
      runId: "run-ascii",
      childSessionKey: "agent:main:main",
      expectedRun: "run-ascii ",
      expectedChild: "agent:main:main                     ",
    },
    {
      name: "a wide run id",
      runId: "界界界",
      childSessionKey: "agent:main:main",
      expectedRun: "界界界    ",
      expectedChild: "agent:main:main                     ",
    },
    {
      name: "a wide child session key",
      runId: "run-ascii",
      childSessionKey: "agent:main:界界界",
      expectedRun: "run-ascii ",
      expectedChild: "agent:main:界界界                   ",
    },
    {
      name: "an exactly fitting combining run id",
      runId: "A".repeat(9) + "e\u0301",
      childSessionKey: "agent:main:main",
      expectedRun: "AAAAAAAAAe\u0301",
      expectedChild: "agent:main:main                     ",
    },
    {
      name: "an exactly fitting combining child session key",
      runId: "run-ascii",
      childSessionKey: "agent:main:" + "x".repeat(24) + "e\u0301",
      expectedRun: "run-ascii ",
      expectedChild: "agent:main:xxxxxxxxxxxxxxxxxxxxxxxxe\u0301",
    },
    {
      name: "bounded zero-width run and child tokens",
      runId: "\u200b".repeat(512),
      childSessionKey: "agent:main:" + "\u200b".repeat(512),
      expectedRun: "\u200b".repeat(70) + "…         ",
      expectedChild: "agent:main:" + "\u200b".repeat(241) + "…" + " ".repeat(24),
    },
    {
      name: "oversized combining run and child graphemes",
      runId: "e" + "\u0301".repeat(512),
      childSessionKey: "agent:main:e" + "\u0301".repeat(512),
      expectedRun: "…         ",
      expectedChild: "agent:main:…" + " ".repeat(24),
    },
    {
      name: "oversized ZWJ run and child graphemes",
      runId: "👩" + "\u200d👩".repeat(128),
      childSessionKey: "agent:main:👩" + "\u200d👩".repeat(128),
      expectedRun: "…         ",
      expectedChild: "agent:main:…" + " ".repeat(24),
    },
    {
      name: "ordinary multi-person emoji tokens",
      runId: "👨‍👩‍👧‍👦".repeat(5),
      childSessionKey: "agent:main:" + "👨‍👩‍👧‍👦".repeat(12),
      expectedRun: "👨‍👩‍👧‍👦".repeat(5),
      expectedChild: "agent:main:" + "👨‍👩‍👧‍👦".repeat(12) + " ",
    },
  ])(
    "aligns task list columns for $name",
    async ({ runId, childSessionKey, expectedRun, expectedChild }) => {
      const task = Object.freeze({
        taskId: "00000000-0000-4000-8000-000000000001",
        runtime: "cli",
        requesterSessionKey: childSessionKey,
        ownerKey: childSessionKey,
        scopeKind: "session",
        childSessionKey,
        agentId: "main",
        runId,
        task: "Inspect output",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
        startedAt: 1,
        lastEventAt: 1,
      } satisfies TaskRecord);
      const query = vi
        .spyOn(taskRegistryReconcile, "reconcileInspectableTasks")
        .mockReturnValue([task]);
      const runtime = createRuntime();
      try {
        await tasksListCommand({}, runtime);
        const lines = vi
          .mocked(runtime.log)
          .mock.calls.map(([line]) => stripVTControlCharacters(String(line)));
        const expectedRow =
          "00000000-… cli      running    not_applicable " +
          `${expectedRun} ${expectedChild} Inspect output`;
        expect(lines.at(-1)).toBe(expectedRow);
        expect(lines).toEqual([
          "Background tasks: 1",
          "Task pressure: 0 queued · 1 running · 0 issues",
          "Task       Kind     Status     Delivery       Run        " +
            "Child Session                        Summary",
          expectedRow,
        ]);
        expect(runtime.error).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(mocks.callGateway).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
    },
  );
});
