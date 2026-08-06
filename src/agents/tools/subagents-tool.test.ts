// Subagents tool tests cover requester-scoped task listing and cancellation.
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskRuntime, TaskStatus } from "../../tasks/task-registry.types.js";
import { TASK_STATUS_DETAIL_MAX_CHARS } from "../../tasks/task-status.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../subagent-lifecycle-events.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
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
  terminalOutcome?: TaskRecord["terminalOutcome"];
  error?: string;
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
    ...(params.terminalOutcome ? { terminalOutcome: params.terminalOutcome } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

describe("subagents tool", () => {
  it("advertises the unified task ledger", () => {
    const tool = createSubagentsTool();

    expect(tool.description).toBe(
      "Background work: subagents, media gen, automation runs. list/cancel.",
    );
  });

  it("reports a killed subagent truthfully through the actual list tool", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const run = {
      runId: "run-tool-killed",
      childSessionKey: "agent:main:subagent:tool-killed",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "report the killed child",
      cleanup: "keep",
      createdAt: now - 2_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        status: "terminal",
        startedAt: now - 2_000,
        endedAt: now - 1_000,
        outcome: { status: "error", error: "agent run aborted" },
      },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);

    try {
      const tool = createSubagentsTool({
        agentSessionKey: "agent:main:main",
        config: {},
        listTasks: () => [],
      });

      const result = await tool.execute("list-killed", { action: "list" });

      expect(result.details).toMatchObject({
        status: "ok",
        recent: [expect.objectContaining({ runId: run.runId, status: "killed" })],
      });
      expect((result.details as { text: string }).text).toContain(" killed");
    } finally {
      resetSubagentRegistryForTests();
    }
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

  it("preserves blocked terminal outcomes and actionable terminal failure reasons", async () => {
    const tasks = [
      task({
        taskId: "blocked",
        runtime: "acp",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session authorization required.",
      }),
      task({
        taskId: "failed",
        runtime: "subagent",
        status: "failed",
        error: "Provider rejected the tool call.",
      }),
      task({
        taskId: "timed-out",
        runtime: "cli",
        status: "timed_out",
        error: "Provider timed out before producing output.",
      }),
    ];
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => tasks,
    });

    const result = await tool.execute("list", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      taskTotal: 3,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          taskId: "blocked",
          status: "blocked",
          terminalOutcome: "blocked",
          terminalSummary: "Writable session authorization required.",
        }),
        expect.objectContaining({
          taskId: "failed",
          status: "failed",
          error: "Provider rejected the tool call.",
        }),
        expect.objectContaining({
          taskId: "timed-out",
          status: "timed_out",
          error: "Provider timed out before producing output.",
        }),
      ]),
    });
  });

  it("bounds terminal failure text with the canonical surrogate-safe task detail budget", async () => {
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => [
        task({
          taskId: "oversized-error",
          runtime: "subagent",
          status: "failed",
          error: "🚀".repeat(20_000),
        }),
      ],
    });

    const result = await tool.execute("list", { action: "list" });
    const [row] = (result.details as { tasks: Array<{ error?: string }> }).tasks;

    if (!row?.error) {
      throw new Error("Expected a sanitized terminal task failure.");
    }
    expect(row.error.length).toBeLessThanOrEqual(TASK_STATUS_DETAIL_MAX_CHARS);
    expect(row.error.endsWith("…")).toBe(true);
    for (const character of row.error) {
      const code = character.charCodeAt(0);
      expect(character.length > 1 || code < 0xd800 || code > 0xdfff).toBe(true);
    }
  });

  it("strips internal provider context and redacts raw approval denial details", async () => {
    const internalContext = [
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "[Internal task completion event]",
      "providerAuthorization: private-provider-context",
    ].join("\n");
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => [
        task({
          taskId: "with-internal-context",
          runtime: "subagent",
          status: "failed",
          error: `Permission denied by ACP runtime.\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${internalContext}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`,
        }),
        task({
          taskId: "only-internal-context",
          runtime: "subagent",
          status: "failed",
          error: internalContext,
        }),
        task({
          taskId: "approval-denied",
          runtime: "acp",
          status: "failed",
          error: "Exec denied (gateway id=req-1, approval-timeout): bash -lc print-private-context",
        }),
      ],
    });

    const result = await tool.execute("list", { action: "list" });
    const rows = (result.details as { tasks: Array<{ taskId: string; error?: string }> }).tasks;

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "with-internal-context",
          error: "Permission denied by ACP runtime.",
        }),
        expect.objectContaining({
          taskId: "approval-denied",
          error: "Command did not run: approval timed out.",
        }),
      ]),
    );
    expect(rows.find((row) => row.taskId === "only-internal-context")).not.toHaveProperty("error");
    expect(JSON.stringify(result.details)).not.toContain("private-provider-context");
    expect(JSON.stringify(result.details)).not.toContain("print-private-context");
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
