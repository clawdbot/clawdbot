// Verifies task domain view projections from registry and flow records.
import { describe, expect, it } from "vitest";
import {
  mapTaskFlowDetail,
  mapTaskFlowView,
  mapTaskRunAggregateSummary,
  mapTaskRunDetail,
  mapTaskRunView,
} from "./task-domain-views.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "Investigate flaky delivery",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 100,
    ...overrides,
  };
}

function makeFlow(overrides: Partial<TaskFlowRecord> = {}): TaskFlowRecord {
  return {
    flowId: "flow-1",
    syncMode: "managed",
    ownerKey: "agent:main:main",
    revision: 3,
    status: "waiting",
    notifyPolicy: "state_changes",
    goal: "Ship a safe fix",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<TaskRegistrySummary> = {}): TaskRegistrySummary {
  return {
    total: 2,
    active: 1,
    terminal: 1,
    failures: 1,
    byStatus: {
      queued: 0,
      running: 1,
      succeeded: 0,
      failed: 1,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: {
      subagent: 1,
      acp: 0,
      cli: 1,
      cron: 0,
    },
    ...overrides,
  };
}

describe("task domain view mappers", () => {
  it("maps task registry summaries without sharing mutable count objects", () => {
    const summary = makeSummary();

    const view = mapTaskRunAggregateSummary(summary);

    expect(view).toEqual(summary);
    expect(view.byStatus).not.toBe(summary.byStatus);
    expect(view.byRuntime).not.toBe(summary.byRuntime);
  });

  it("maps task run records to the public task run view contract", () => {
    const task = makeTask({
      taskId: "task-full",
      runtime: "cli",
      sourceId: "source-1",
      requesterSessionKey: "agent:main:telegram:chat-1",
      ownerKey: "agent:main:main",
      scopeKind: "system",
      childSessionKey: "agent:main:subagent:child-1",
      parentFlowId: "flow-1",
      parentTaskId: "task-parent",
      agentId: "main",
      runId: "run-1",
      label: "diagnostics",
      task: "Run diagnostics",
      status: "failed",
      deliveryStatus: "failed",
      notifyPolicy: "state_changes",
      createdAt: 100,
      startedAt: 110,
      endedAt: 200,
      lastEventAt: 190,
      cleanupAfter: 1_000,
      error: "Command failed",
      progressSummary: "Checking logs",
      terminalSummary: "Diagnostics failed",
      terminalOutcome: "blocked",
    });

    expect(mapTaskRunView(task)).toEqual({
      id: "task-full",
      runtime: "cli",
      sourceId: "source-1",
      sessionKey: "agent:main:telegram:chat-1",
      ownerKey: "agent:main:main",
      scope: "system",
      childSessionKey: "agent:main:subagent:child-1",
      flowId: "flow-1",
      parentTaskId: "task-parent",
      agentId: "main",
      runId: "run-1",
      label: "diagnostics",
      title: "Run diagnostics",
      status: "failed",
      deliveryStatus: "failed",
      notifyPolicy: "state_changes",
      createdAt: 100,
      startedAt: 110,
      endedAt: 200,
      lastEventAt: 190,
      cleanupAfter: 1_000,
      error: "Command failed",
      progressSummary: "Checking logs",
      terminalSummary: "Diagnostics failed",
      terminalOutcome: "blocked",
    });
  });

  it("keeps task run detail aligned with the task run view shape", () => {
    const task = makeTask({ taskId: "task-detail", runId: "run-detail" });

    expect(mapTaskRunDetail(task)).toEqual(mapTaskRunView(task));
  });

  it("maps task flow records to public flow views without sharing requester origins", () => {
    const requesterOrigin = {
      channel: "telegram",
      to: "chat-1",
      threadId: 123,
      deliveryIntent: { id: "intent-1", kind: "outbound_queue" as const },
    };
    const flow = makeFlow({
      requesterOrigin,
      currentStep: "wait_for_task",
      cancelRequestedAt: 18,
      endedAt: 30,
    });

    const view = mapTaskFlowView(flow);

    expect(view).toEqual({
      id: "flow-1",
      ownerKey: "agent:main:main",
      requesterOrigin,
      status: "waiting",
      notifyPolicy: "state_changes",
      goal: "Ship a safe fix",
      currentStep: "wait_for_task",
      cancelRequestedAt: 18,
      createdAt: 10,
      updatedAt: 20,
      endedAt: 30,
    });
    expect(view.requesterOrigin).not.toBe(requesterOrigin);
  });

  it("maps flow details with supplied task summary and nested task views", () => {
    const task = makeTask({ taskId: "task-child", parentFlowId: "flow-1" });
    const summary = makeSummary();
    const flow = makeFlow({
      stateJson: { phase: "waiting" },
      waitJson: { kind: "task", taskId: "task-child" },
      blockedTaskId: "task-child",
      blockedSummary: "Waiting for child task",
    });

    const detail = mapTaskFlowDetail({ flow, tasks: [task], summary });

    expect(detail).toEqual({
      ...mapTaskFlowView(flow),
      state: { phase: "waiting" },
      wait: { kind: "task", taskId: "task-child" },
      blocked: {
        taskId: "task-child",
        summary: "Waiting for child task",
      },
      tasks: [mapTaskRunView(task)],
      taskSummary: mapTaskRunAggregateSummary(summary),
    });
    expect(detail.taskSummary.byStatus).not.toBe(summary.byStatus);
    expect(detail.taskSummary.byRuntime).not.toBe(summary.byRuntime);
  });

  it("summarizes nested tasks when flow detail callers do not provide a summary", () => {
    const running = makeTask({ taskId: "task-running", status: "running", runtime: "subagent" });
    const failed = makeTask({ taskId: "task-failed", status: "failed", runtime: "cli" });

    const detail = mapTaskFlowDetail({ flow: makeFlow(), tasks: [running, failed] });

    expect(detail.taskSummary).toEqual(makeSummary());
  });
});
