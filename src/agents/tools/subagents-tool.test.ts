// Subagents tool tests cover requester-scoped task listing and cancellation.
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskRuntime, TaskStatus } from "../../tasks/task-registry.types.js";
import { createSubagentsTool } from "./subagents-tool.js";

function task(params: {
  taskId: string;
  runtime: TaskRuntime;
  status?: TaskStatus;
  ownerKey?: string;
  requesterSessionKey?: string;
  childSessionKey?: string;
  label?: string;
  progressSummary?: string;
  terminalSummary?: string;
}): TaskRecord {
  return {
    taskId: params.taskId,
    runtime: params.runtime,
    ownerKey: params.ownerKey ?? "agent:main:main",
    requesterSessionKey: params.requesterSessionKey ?? "agent:main:main",
    scopeKind: "session",
    task: params.taskId,
    status: params.status ?? "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "done_only",
    createdAt: Date.now(),
    lastEventAt: Date.now(),
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
    ...(params.label ? { label: params.label } : {}),
    ...(params.progressSummary ? { progressSummary: params.progressSummary } : {}),
    ...(params.terminalSummary ? { terminalSummary: params.terminalSummary } : {}),
  };
}

describe("subagents tool", () => {
  it("advertises the unified task ledger", () => {
    const tool = createSubagentsTool();

    expect(tool.description).toBe("Background work: subagents, media gen, cron runs. list/cancel.");
  });

  it("lists cross-runtime tasks in the caller session tree", async () => {
    const tasks = [
      task({
        taskId: "subagent-task",
        runtime: "subagent",
        childSessionKey: "agent:main:dashboard:child",
        label: "Research",
        progressSummary: "Reading",
      }),
      task({ taskId: "acp-task", runtime: "acp", status: "succeeded", terminalSummary: "Done" }),
      task({ taskId: "cli-task", runtime: "cli" }),
      task({ taskId: "cron-task", runtime: "cron" }),
      task({
        taskId: "outside-owner",
        runtime: "cli",
        ownerKey: "agent:other:main",
        requesterSessionKey: "agent:main:main",
      }),
      task({
        taskId: "child-task",
        runtime: "cli",
        ownerKey: "agent:main:dashboard:child",
        requesterSessionKey: "agent:main:dashboard:child",
      }),
      task({
        taskId: "outside",
        runtime: "cron",
        ownerKey: "agent:other:main",
        requesterSessionKey: "agent:other:main",
      }),
    ];
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => tasks,
    });

    const result = await tool.execute("list", { action: "list" });

    expect(result.details).toMatchObject({ status: "ok", taskTotal: 5 });
    const rows = (result.details as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "subagent-task",
          runtime: "subagent",
          status: "running",
          label: "Research",
          progressSummary: "Reading",
        }),
        expect.objectContaining({
          taskId: "acp-task",
          runtime: "acp",
          status: "completed",
          terminalSummary: "Done",
        }),
        expect.objectContaining({ taskId: "cli-task", runtime: "cli" }),
        expect.objectContaining({ taskId: "cron-task", runtime: "cron" }),
        expect.objectContaining({ taskId: "child-task", runtime: "cli" }),
      ]),
    );
    expect(rows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "outside" }),
        expect.objectContaining({ taskId: "outside-owner" }),
      ]),
    );
  });

  it("cancels only tasks in the caller session tree", async () => {
    const tasks = [
      task({ taskId: "inside", runtime: "cli" }),
      task({
        taskId: "outside",
        runtime: "cron",
        ownerKey: "agent:other:main",
        requesterSessionKey: "agent:other:main",
      }),
      task({
        taskId: "outside-owner",
        runtime: "cli",
        ownerKey: "agent:other:main",
        requesterSessionKey: "agent:main:main",
      }),
    ];
    const cancelTask = vi.fn(async () => ({ found: true, cancelled: true }));
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => tasks,
      cancelTask: cancelTask as never,
    });

    await expect(tool.execute("cancel", { action: "cancel", taskId: "inside" })).resolves.toEqual(
      expect.objectContaining({ details: expect.objectContaining({ status: "cancelled" }) }),
    );
    expect(cancelTask).toHaveBeenCalledWith({ cfg: {}, taskId: "inside" });

    await expect(
      tool.execute("cancel-outside", { action: "cancel", taskId: "outside" }),
    ).resolves.toEqual(
      expect.objectContaining({ details: expect.objectContaining({ status: "forbidden" }) }),
    );
    expect(cancelTask).toHaveBeenCalledTimes(1);

    await expect(
      tool.execute("cancel-outside-owner", { action: "cancel", taskId: "outside-owner" }),
    ).resolves.toEqual(
      expect.objectContaining({ details: expect.objectContaining({ status: "forbidden" }) }),
    );
    expect(cancelTask).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1.5])("rejects invalid recentMinutes value %s", async (recentMinutes) => {
    const tool = createSubagentsTool();

    await expect(
      tool.execute("call-1", {
        action: "list",
        recentMinutes,
      }),
    ).rejects.toThrow("recentMinutes must be a positive integer");
  });
});
