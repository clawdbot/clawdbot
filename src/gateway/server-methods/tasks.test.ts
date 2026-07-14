/**
 * Tests for task gateway methods and persisted task lifecycle responses.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  getTaskById,
  markTaskTerminalById,
  recordTaskProgressByRunId,
} from "../../tasks/runtime-internal.js";
import {
  reloadTaskRegistryFromStore,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../tasks/task-registry.js";
import { saveTaskRegistryStateToSqlite } from "../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { tasksHandlers } from "./tasks.js";
import type { RespondFn } from "./types.js";

const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const cancelSessionMock = vi.fn();
const killSubagentRunAdminMock = vi.fn();
type TaskResponsePayload = {
  tasks?: Array<Record<string, unknown>>;
  task?: Record<string, unknown>;
  found?: boolean;
  cancelled?: boolean;
  nextCursor?: string;
};

let stateDir: string;

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-tasks-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  resetTaskRegistryForTests();
  cancelSessionMock.mockReset();
  killSubagentRunAdminMock.mockReset();
  setTaskRegistryControlRuntimeForTests({
    cancelActiveCronTaskRun: () => false,
    getAcpSessionManager: () => ({
      cancelSession: cancelSessionMock,
    }),
    killSubagentRunAdmin: async (params) => killSubagentRunAdminMock(params),
  });
});

afterEach(async () => {
  resetTaskRegistryControlRuntimeForTests();
  resetTaskRegistryForTests();
  stateDirEnvSnapshot.restore();
  await fs.rm(stateDir, { recursive: true, force: true });
});

function captureRespond() {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  return { calls, respond };
}

function createContext() {
  return {
    getRuntimeConfig: () => ({}),
  } as never;
}

function createSnapshotTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-snapshot",
    runtime: "cli",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: "run-snapshot",
    task: "Snapshot task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 1_000,
    startedAt: 1_010,
    lastEventAt: 1_010,
    ...overrides,
  };
}

async function runTaskHandler(
  method: "tasks.list" | "tasks.get" | "tasks.cancel",
  params: Record<string, unknown>,
) {
  const { calls, respond } = captureRespond();
  await expectDefined(
    tasksHandlers[method],
    "tasksHandlers[method] test invariant",
  )({
    req: { type: "req", id: `req-${method}`, method },
    params,
    respond,
    context: createContext(),
    client: null,
    isWebchatConnect: () => false,
  });
  return {
    calls,
    payload: calls[0]?.[1] as TaskResponsePayload | undefined,
  };
}

async function getTaskPayload(taskId: string) {
  const { calls, payload } = await runTaskHandler("tasks.get", { taskId });
  expect(calls[0]?.[0]).toBe(true);
  expect(payload?.task?.id).toBe(taskId);
  return { calls, payload };
}

describe("tasks gateway handlers", () => {
  it("lists task summaries with SDK-facing statuses and filters", async () => {
    const running = createTaskRecord({
      runtime: "subagent",
      taskKind: "investigation",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      agentId: "main",
      runId: "run-running",
      task: "Investigate issue",
      status: "running",
      deliveryStatus: "pending",
    });
    createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:other:main",
      ownerKey: "agent:other:main",
      scopeKind: "session",
      runId: "run-other",
      task: "Other task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.list", {
      status: "running",
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.tasks).toHaveLength(1);
    const listedTask = payload?.tasks?.[0];
    expect(listedTask?.id).toBe(running.taskId);
    expect(listedTask?.taskId).toBe(running.taskId);
    expect(listedTask?.kind).toBe("investigation");
    expect(listedTask?.runtime).toBe("subagent");
    expect(listedTask?.status).toBe("running");
    expect(listedTask?.title).toBe("Investigate issue");
    expect(listedTask?.agentId).toBe("main");
    expect(listedTask?.sessionKey).toBe("agent:main:main");
    expect(listedTask?.childSessionKey).toBe("agent:worker:subagent:child");
    expect(listedTask?.runId).toBe("run-running");
  });

  it("orders the ledger by last activity, not creation time", async () => {
    // The registry lists newest-created first; the wire must page by last
    // activity so an old task that just finished is not hidden behind
    // newer-created records.
    const base = Date.now();
    const oldButJustFinished = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Old long-running task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      lastEventAt: base + 60_000,
    });
    const newerQuietTask = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Newer quiet task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      lastEventAt: base + 1_000,
    });

    const { payload } = await runTaskHandler("tasks.list", {});
    const ids = payload?.tasks?.map((task) => task.id);
    expect(ids?.indexOf(oldButJustFinished.taskId)).toBeLessThan(
      ids?.indexOf(newerQuietTask.taskId) ?? -1,
    );
  });

  it("preserves activity ordering across cursor pages", async () => {
    const created = [500, 100, 700, 300, 500].map((lastEventAt, index) =>
      createTaskRecord({
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: `run-page-${index}`,
        task: `Paged task ${index}`,
        status: "succeeded",
        deliveryStatus: "not_applicable",
        lastEventAt,
      }),
    );
    const expectedIds = created
      .toSorted((left, right) => {
        const updatedDiff = (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0);
        if (updatedDiff !== 0) {
          return updatedDiff;
        }
        return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
      })
      .map((task) => task.taskId);

    const page1 = await runTaskHandler("tasks.list", { limit: 2 });
    expect(page1.calls[0]?.[0]).toBe(true);
    expect(page1.payload?.tasks?.map((task) => task.id)).toEqual(expectedIds.slice(0, 2));
    expect(page1.payload?.nextCursor).toBe("2");

    const page2 = await runTaskHandler("tasks.list", { limit: 2, cursor: "2" });
    expect(page2.payload?.tasks?.map((task) => task.id)).toEqual(expectedIds.slice(2, 4));
    expect(page2.payload?.nextCursor).toBe("4");

    const page3 = await runTaskHandler("tasks.list", { limit: 2, cursor: "4" });
    expect(page3.payload?.tasks?.map((task) => task.id)).toEqual(expectedIds.slice(4));
    expect(page3.payload?.nextCursor).toBeUndefined();
  });

  it("treats explicit task agentId as authoritative over the session-key fallback", async () => {
    // Cross-agent subagent task: the registry derives agentId=worker from the
    // child session key, while owner/requester keys belong to main. tasks.list
    // for main must not leak the worker task through the session-key fallback.
    const workerTask = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      runId: "run-worker-authoritative",
      task: "Inspect worker state",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(workerTask.agentId).toBe("worker");

    const mainView = await runTaskHandler("tasks.list", { agentId: "main" });
    expect(mainView.calls[0]?.[0]).toBe(true);
    expect(mainView.payload?.tasks ?? []).toEqual([]);

    const workerView = await runTaskHandler("tasks.list", { agentId: "worker" });
    expect(workerView.payload?.tasks?.map((task) => task.taskId)).toEqual([workerTask.taskId]);
  });

  it("gets completed tasks with stable completed status", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-completed",
      task: "Done task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
    });

    const { payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.status).toBe("completed");
    expect(payload?.task?.title).toBe("Done task");
  });

  it("sanitizes task text before exposing SDK summaries", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-sanitized",
      label:
        "Compile artifact\nOpenClaw runtime context (internal): Keep internal details private.",
      task: "Compile artifact",
      status: "running",
      deliveryStatus: "pending",
    });
    recordTaskProgressByRunId({
      runId: "run-sanitized",
      progressSummary:
        "Bundling output\nOpenClaw runtime context (internal): Keep internal details private.",
    });
    markTaskTerminalById({
      taskId: task.taskId,
      status: "failed",
      endedAt: Date.now(),
      terminalSummary:
        "Failed after build\nOpenClaw runtime context (internal): Keep internal details private.",
      error: "Tool failed\nOpenClaw runtime context (internal): Keep internal details private.",
    });

    const { calls, payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.title).toBe("Compile artifact");
    expect(payload?.task?.terminalSummary).toBe("Failed after build");
    expect(payload?.task?.error).toBe("Tool failed");
    expect(JSON.stringify(calls[0]?.[1])).not.toContain("OpenClaw runtime context");
  });

  it("exposes tool activity in task summaries", async () => {
    const task = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:activity",
      runId: "run-tool-activity",
      task: "Sweep the repo",
      status: "running",
      deliveryStatus: "not_applicable",
    });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "call-1" },
    });
    emitAgentEvent({
      runId: "run-tool-activity",
      stream: "tool",
      data: { phase: "start", name: "exec", toolCallId: "call-2" },
    });

    const { payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.toolUseCount).toBe(2);
    expect(payload?.task?.lastToolName).toBe("exec");
  });

  it("cancels running task records and returns the updated task", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-cancel",
      task: "Cancelable task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "user stopped task",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(true);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("cancelled");
    expect(payload?.task?.error).toBe("user stopped task");
  });

  it("cancels ACP tasks through the live Gateway handler and control runtime", async () => {
    const task = createSnapshotTask({
      taskId: "task-acp-primary",
      runtime: "acp",
      childSessionKey: "agent:codex:acp:child",
      agentId: "codex",
      runId: "run-cancel-acp-gateway",
      task: "Primary ACP task",
    });
    const siblingTask = createSnapshotTask({
      taskId: "task-acp-sibling",
      runtime: "acp",
      childSessionKey: "agent:codex:acp:child",
      agentId: "codex",
      runId: "run-cancel-acp-gateway",
      task: "Sibling ACP task",
      createdAt: 1_001,
      startedAt: 1_011,
      lastEventAt: 1_011,
    });
    saveTaskRegistryStateToSqlite({
      tasks: new Map([
        [task.taskId, task],
        [siblingTask.taskId, siblingTask],
      ]),
      deliveryStates: new Map(),
    });
    reloadTaskRegistryFromStore();
    cancelSessionMock.mockResolvedValue(undefined);

    const { calls, payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "operator requested stop",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(cancelSessionMock).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "agent:codex:acp:child",
      reason: "operator requested stop",
    });
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(true);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("cancelled");
    expect(getTaskById(task.taskId)?.status).toBe("cancelled");
    expect(getTaskById(siblingTask.taskId)?.status).toBe("cancelled");
    expect(getTaskById(siblingTask.taskId)?.error).toBe("operator requested stop");
  });
});
