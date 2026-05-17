import { describe, expect, it } from "vitest";
import {
  formatTaskBlockedFollowupMessage,
  formatTaskStateChangeMessage,
  formatTaskTerminalMessage,
  isTerminalTaskStatus,
  shouldAutoDeliverTaskStateChange,
  shouldAutoDeliverTaskTerminalUpdate,
  shouldSuppressDuplicateTerminalDelivery,
  shouldUseParentReviewTaskTerminalMessage,
} from "./task-executor-policy.js";
import type { TaskEventRecord, TaskRecord } from "./task-registry.types.js";

function createTask(partial: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: partial.taskId ?? "task-1",
    runtime: partial.runtime ?? "acp",
    requesterSessionKey: partial.requesterSessionKey ?? partial.ownerKey ?? "agent:main:main",
    ownerKey: partial.ownerKey ?? partial.requesterSessionKey ?? "agent:main:main",
    scopeKind: partial.scopeKind ?? "session",
    task: partial.task ?? "Investigate issue",
    status: partial.status ?? "running",
    deliveryStatus: partial.deliveryStatus ?? "pending",
    notifyPolicy: partial.notifyPolicy ?? "done_only",
    createdAt: partial.createdAt ?? 1,
    ...partial,
  };
}

describe("task-executor-policy", () => {
  it("identifies terminal statuses", () => {
    expect(isTerminalTaskStatus("queued")).toBe(false);
    expect(isTerminalTaskStatus("running")).toBe(false);
    expect(isTerminalTaskStatus("succeeded")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("timed_out")).toBe(true);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
    expect(isTerminalTaskStatus("lost")).toBe(true);
  });

  it("formats terminal, followup, and progress messages", () => {
    const succeededTask = createTask({
      status: "succeeded",
      terminalSummary: "Imported 12 rows.",
      runId: "run-0234567890",
      label: "ACP import",
    });
    const blockedTask = createTask({
      status: "succeeded",
      terminalOutcome: "blocked",
      terminalSummary: "Needs login.",
      runId: "run-1234567890",
      label: "ACP import",
    });
    const progressEvent: TaskEventRecord = {
      at: 10,
      kind: "progress",
      summary: "No output for 60s.",
    };

    expect(formatTaskTerminalMessage(succeededTask, { surface: "parent_session" })).toBe(
      "Background task ready for review: ACP import (run run-0234). Imported 12 rows. Next: parent will review/verify before calling it done.",
    );
    expect(formatTaskTerminalMessage(succeededTask)).toBe(
      "Background task done: ACP import (run run-0234). Imported 12 rows.",
    );
    expect(formatTaskTerminalMessage(blockedTask)).toBe(
      "Background task blocked: ACP import (run run-1234). Needs login.",
    );
    expect(formatTaskBlockedFollowupMessage(blockedTask)).toBe(
      "Task needs follow-up: ACP import (run run-1234). Needs login.",
    );
    expect(formatTaskStateChangeMessage(blockedTask, progressEvent)).toBe(
      "Background task update: ACP import. No output for 60s.",
    );
  });

  it("sanitizes leaked internal runtime context from terminal and progress copy", () => {
    const leaked = [
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "[Internal task completion event]",
      "source: subagent",
    ].join("\n");
    const blockedTask = createTask({
      status: "succeeded",
      terminalOutcome: "blocked",
      terminalSummary: leaked,
      runId: "run-1234567890",
      label: leaked,
    });
    const failedTask = createTask({
      status: "failed",
      error: leaked,
      terminalSummary: "Needs manual approval.",
      runId: "run-2234567890",
      label: leaked,
    });
    const progressEvent: TaskEventRecord = {
      at: 10,
      kind: "progress",
      summary: leaked,
    };

    expect(formatTaskTerminalMessage(blockedTask)).toBe(
      "Background task blocked: Background task (run run-1234).",
    );
    expect(formatTaskBlockedFollowupMessage(blockedTask)).toBe(
      "Task needs follow-up: Background task (run run-1234). Task is blocked and needs follow-up.",
    );
    expect(formatTaskTerminalMessage(failedTask)).toBe(
      "Background task failed: Background task (run run-2234). Needs manual approval.",
    );
    expect(formatTaskStateChangeMessage(blockedTask, progressEvent)).toBeNull();
  });

  it("redacts raw exec denial text from blocked task updates", () => {
    const blockedTask = createTask({
      status: "succeeded",
      terminalOutcome: "blocked",
      terminalSummary: "Exec denied (gateway id=req-1, approval-timeout): bash -lc ls",
      runId: "run-1234567890",
      label: "ACP import",
    });

    expect(formatTaskTerminalMessage(blockedTask)).toBe(
      "Background task blocked: ACP import (run run-1234). Command did not run: approval timed out.",
    );
    expect(formatTaskBlockedFollowupMessage(blockedTask)).toBe(
      "Task needs follow-up: ACP import (run run-1234). Command did not run: approval timed out.",
    );
  });

  it("keeps delivery policy decisions explicit", () => {
    expect(
      shouldAutoDeliverTaskTerminalUpdate(
        createTask({
          status: "succeeded",
          deliveryStatus: "pending",
          notifyPolicy: "done_only",
        }),
      ),
    ).toBe(true);
    expect(
      shouldAutoDeliverTaskTerminalUpdate(
        createTask({
          runtime: "subagent",
          status: "succeeded",
          deliveryStatus: "pending",
        }),
      ),
    ).toBe(false);
    expect(
      shouldAutoDeliverTaskStateChange(
        createTask({
          status: "running",
          notifyPolicy: "state_changes",
          deliveryStatus: "pending",
        }),
      ),
    ).toBe(true);
    expect(
      shouldAutoDeliverTaskStateChange(
        createTask({
          status: "failed",
          notifyPolicy: "state_changes",
          deliveryStatus: "pending",
        }),
      ),
    ).toBe(false);
    expect(
      shouldSuppressDuplicateTerminalDelivery({
        task: createTask({
          runtime: "acp",
          runId: "run-duplicate",
        }),
        preferredTaskId: "task-2",
      }),
    ).toBe(true);
    expect(
      shouldSuppressDuplicateTerminalDelivery({
        task: createTask({
          runtime: "acp",
          runId: "run-duplicate",
        }),
        preferredTaskId: "task-1",
      }),
    ).toBe(false);
    expect(
      shouldSuppressDuplicateTerminalDelivery({
        task: createTask({
          runtime: "acp",
          runId: "run-duplicate",
        }),
        preferredTaskId: undefined,
      }),
    ).toBe(false);
    expect(
      shouldUseParentReviewTaskTerminalMessage(
        createTask({
          runtime: "acp",
          childSessionKey: "agent:main:acp:child",
          status: "succeeded",
        }),
      ),
    ).toBe(true);
    expect(
      shouldUseParentReviewTaskTerminalMessage(
        createTask({
          runtime: "acp",
          taskKind: "context_engine_turn_maintenance",
          status: "succeeded",
        }),
      ),
    ).toBe(false);
  });
});
