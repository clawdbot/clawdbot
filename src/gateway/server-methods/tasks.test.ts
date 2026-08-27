/**
 * Tests for task gateway methods and persisted task lifecycle responses.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  getTaskById,
  listTaskRecordPage,
  markTaskTerminalById,
  recordTaskProgressByRunId,
} from "../../tasks/runtime-internal.js";
import { reloadTaskRegistryFromStore } from "../../tasks/task-registry.js";
import { saveTaskRegistryStateToSqlite } from "../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { tasksHandlers } from "./tasks.js";
import type { GatewayClient, RespondFn } from "./types.js";

const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const cancelSessionMock = vi.fn();
const killSubagentRunAdminMock = vi.fn();
type TaskResponsePayload = {
  tasks?: Array<Record<string, unknown>>;
  task?: Record<string, unknown>;
  found?: boolean;
  cancelled?: boolean;
  nextCursor?: string;
  results?: Array<{ taskId?: string; ok?: boolean; reason?: string }>;
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
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await fs.rm(stateDir, { recursive: true, force: true });
});

function identifiedClient(scopes: string[], profileId = "viewer@example.com"): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
    authenticatedUserId: "viewer@example.com",
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

function captureRespond() {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => {
    calls.push(args);
  };
  return { calls, respond };
}

function createContext(config: Record<string, unknown> = {}) {
  return {
    getRuntimeConfig: () => config,
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
  method: "tasks.list" | "tasks.get" | "tasks.cancel" | "tasks.retry" | "tasks.dismiss",
  params: Record<string, unknown>,
  config: Record<string, unknown> = {},
  client: GatewayClient | null = null,
) {
  const { calls, respond } = captureRespond();
  await expectDefined(
    tasksHandlers[method],
    "tasksHandlers[method] test invariant",
  )({
    req: { type: "req", id: `req-${method}`, method },
    params,
    respond,
    context: createContext(config),
    client,
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
      sessionKey: "main",
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

    const canonical = await runTaskHandler("tasks.list", {
      status: "running",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(canonical.payload?.tasks?.map((task) => task.taskId)).toEqual([running.taskId]);
  });

  it("uses the persisted fixed-store owner for a bare task session filter", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "global",
      ownerKey: "global",
      scopeKind: "session",
      runId: "run-global",
      task: "Owned task",
      status: "running",
      deliveryStatus: "pending",
    });
    const { calls, payload } = await runTaskHandler(
      "tasks.list",
      { sessionKey: "global" },
      {
        session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          list: [{ id: "ops" }, { id: "research" }],
          defaults: { sessionStore: { agentId: "ops" } },
        },
      },
    );

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.tasks?.map((entry) => entry.taskId)).toEqual([task.taskId]);
  });

  it("does not use the executor as the requester owner for a legacy bare task", () => {
    const task = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "global",
      ownerKey: "global",
      scopeKind: "session",
      childSessionKey: "agent:research:subagent:child",
      agentId: "research",
      runId: "run-legacy-owner",
      task: "Owned by ops, executed by research",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(task.requesterAgentId).toBeUndefined();
    const cfg = {
      session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(
      listTaskRecordPage({
        offset: 0,
        limit: 10,
        sessionKey: "global",
        sessionAgentId: "ops",
        cfg,
      }).tasks.map((entry) => entry.taskId),
    ).toEqual([task.taskId]);
    expect(
      listTaskRecordPage({
        offset: 0,
        limit: 10,
        sessionKey: "global",
        sessionAgentId: "research",
        cfg,
      }).tasks,
    ).toEqual([]);
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

  it("ranks terminal tasks by completion time when the progress timestamp is stale", async () => {
    const base = Date.now();
    const justFinished = createSnapshotTask({
      taskId: "task-just-finished",
      runId: "run-just-finished",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      createdAt: base - 10_000,
      startedAt: base - 9_000,
      lastEventAt: base - 5_000,
      endedAt: base - 1_000,
    });
    const finishedEarlier = createSnapshotTask({
      taskId: "task-finished-earlier",
      runId: "run-finished-earlier",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      createdAt: base - 8_000,
      startedAt: base - 7_000,
      lastEventAt: base - 2_000,
      endedAt: base - 3_000,
    });
    saveTaskRegistryStateToSqlite({
      tasks: new Map([
        [justFinished.taskId, justFinished],
        [finishedEarlier.taskId, finishedEarlier],
      ]),
      deliveryStates: new Map(),
    });
    reloadTaskRegistryFromStore();

    const { payload } = await runTaskHandler("tasks.list", {});

    expect(payload?.tasks?.map((task) => task.taskId)).toEqual([
      justFinished.taskId,
      finishedEarlier.taskId,
    ]);
  });

  it("ranks a terminal task by its later activity when completion trails it", async () => {
    const base = Date.now();
    const laterActivity = createSnapshotTask({
      taskId: "task-later-activity",
      runId: "run-later-activity",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      createdAt: base - 10_000,
      startedAt: base - 9_000,
      lastEventAt: base - 100,
      endedAt: base - 2_000,
    });
    const laterCompletion = createSnapshotTask({
      taskId: "task-later-completion",
      runId: "run-later-completion",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      createdAt: base - 8_000,
      startedAt: base - 7_000,
      lastEventAt: base - 4_000,
      endedAt: base - 500,
    });
    saveTaskRegistryStateToSqlite({
      tasks: new Map([
        [laterActivity.taskId, laterActivity],
        [laterCompletion.taskId, laterCompletion],
      ]),
      deliveryStates: new Map(),
    });
    reloadTaskRegistryFromStore();

    const { payload } = await runTaskHandler("tasks.list", {});
    const byId = new Map(payload?.tasks?.map((task) => [task.taskId, task]));

    expect(payload?.tasks?.map((task) => task.taskId)).toEqual([
      laterActivity.taskId,
      laterCompletion.taskId,
    ]);
    expect(byId.get("task-later-activity")?.updatedAt).toBe(base - 100);
    expect(byId.get("task-later-completion")?.updatedAt).toBe(base - 500);
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

  it("uses task id as the stable activity-order tie break", async () => {
    const sharedActivityAt = 5_000;
    const laterId = createSnapshotTask({
      taskId: "task-z",
      runId: "run-z",
      lastEventAt: sharedActivityAt,
    });
    const earlierId = createSnapshotTask({
      taskId: "task-a",
      runId: "run-a",
      lastEventAt: sharedActivityAt,
    });
    saveTaskRegistryStateToSqlite({
      tasks: new Map([
        [laterId.taskId, laterId],
        [earlierId.taskId, earlierId],
      ]),
      deliveryStates: new Map(),
    });
    reloadTaskRegistryFromStore();

    const { payload } = await runTaskHandler("tasks.list", {});

    expect(payload?.tasks?.map((task) => task.taskId)).toEqual(["task-a", "task-z"]);
  });

  it("clones only the requested task page", async () => {
    for (let index = 0; index < 6; index++) {
      createTaskRecord({
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: `Task ${index}`,
        status: "succeeded",
        deliveryStatus: "not_applicable",
        detail: { index },
      });
    }
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    try {
      const { payload } = await runTaskHandler("tasks.list", { limit: 2 });

      expect(payload?.tasks).toHaveLength(2);
      expect(payload?.nextCursor).toBe("2");
      expect(cloneSpy).toHaveBeenCalledTimes(2);
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it.each(["incognito", "none", "view"] as const)(
    "enforces %s session access on indirect task selectors",
    async (access) => {
      const profileId =
        access === "incognito"
          ? "viewer@example.com"
          : ensureProfileForEmail("viewer@example.com").id;
      const foreignKey = `agent:main:dashboard:${access === "incognito" ? "incognito-" : ""}foreign`;
      const ownKey = "agent:main:own-task";
      for (const [sessionKey, actorId] of [
        [foreignKey, "owner@example.com"],
        [ownKey, profileId],
      ] satisfies [string, string][]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: `session-${sessionKey}`,
            updatedAt: 1,
            createdActor: { type: "human", id: actorId },
            visibility: "shared",
            ...(access === "incognito" && sessionKey === foreignKey ? { incognito: true } : {}),
          },
        );
      }
      const createTask = (sessionKey: string, lastEventAt: number) =>
        createTaskRecord({
          runtime: "cli",
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          ownerKey: sessionKey,
          scopeKind: "session",
          task: sessionKey,
          status: "running",
          deliveryStatus: "pending",
          lastEventAt,
        });
      const foreign = createTask(foreignKey, 2_000);
      const own = createTask(ownKey, 1_000);
      const guest: GatewayOperatorRoleDefinition = {
        sessions: { others: access === "none" ? "none" : "view" },
        agents: "*",
        scopes: ["operator.read", "operator.write"],
      };
      const config: OpenClawConfig =
        access === "incognito"
          ? {}
          : { gateway: { roles: { default: "guest", definitions: { guest } } } };
      const viewer = identifiedClient(["operator.read", "operator.write"], profileId);
      const taskId = foreign.taskId;
      const selection = { taskIds: [taskId] };
      const list = await runTaskHandler("tasks.list", { limit: 1 }, config, viewer);
      const visibleForeign = access === "view";
      expect(list.payload?.tasks?.map((task) => task.taskId)).toEqual([
        visibleForeign ? taskId : own.taskId,
      ]);
      expect(list.payload?.nextCursor).toBe(visibleForeign ? "1" : undefined);
      const get = await runTaskHandler("tasks.get", { taskId }, config, viewer);
      if (visibleForeign) {
        expect(get.payload?.task?.taskId).toBe(taskId);
      } else {
        expect(get.calls[0]).toMatchObject([
          false,
          undefined,
          { message: `task not found: ${taskId}` },
        ]);
      }
      const cancel = await runTaskHandler("tasks.cancel", { taskId }, config, viewer);
      expect(cancel.payload).toMatchObject({ found: false, cancelled: false });
      for (const method of ["tasks.retry", "tasks.dismiss"] as const) {
        const result = await runTaskHandler(method, selection, config, viewer);
        expect(result.payload?.results).toEqual([{ taskId, ok: false, reason: "task not found" }]);
      }
      if (visibleForeign) {
        addSessionMember(
          { agentId: "main", sessionKey: foreignKey },
          {
            identityId: profileId,
            addedBy: "owner@example.com",
            expectedSessionId: `session-${foreignKey}`,
          },
        );
        const invited = await runTaskHandler("tasks.retry", selection, config, viewer);
        expect(invited.payload?.results?.[0]?.reason).not.toBe("task not found");
      }
      const admin = await runTaskHandler(
        "tasks.get",
        { taskId },
        config,
        identifiedClient(["operator.admin"], profileId),
      );
      expect(admin.calls[0]?.[0]).toBe(true);
      expect(admin.payload?.task?.taskId).toBe(taskId);
    },
  );

  it("returns page records isolated from the registry", () => {
    const created = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Isolated task",
      status: "running",
      deliveryStatus: "pending",
      detail: { nested: { value: "original" } },
    });

    const page = listTaskRecordPage({ offset: 0, limit: 1 });
    const detail = page.tasks[0]?.detail as { nested: { value: string } } | undefined;
    expect(detail).toBeDefined();
    if (detail) {
      detail.nested.value = "mutated";
    }

    const current = expectDefined(
      getTaskById(created.taskId),
      "page mutation must not change the registry record",
    );
    expect((current.detail as { nested: { value: string } }).nested.value).toBe("original");
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
    expect(payload?.task?.prompt).toBe("Done task");
  });

  it.each([
    {
      label: "subagent completion",
      runtime: "subagent",
      progressSummary: "Subagent canonical result",
      terminalSummary: "Subagent terminal status",
      expected: "Subagent canonical result",
    },
    {
      label: "ACP completion",
      runtime: "acp",
      progressSummary: "ACP canonical result",
      terminalSummary: "ACP terminal status",
      expected: "ACP canonical result",
    },
    {
      label: "cron completion",
      runtime: "cron",
      progressSummary: "Cron stale progress",
      terminalSummary: "Cron canonical result",
      expected: "Cron canonical result",
    },
    {
      label: "CLI completion",
      runtime: "cli",
      progressSummary: "CLI stale progress",
      terminalSummary: "CLI canonical result",
      expected: "CLI canonical result",
    },
    {
      label: "CLI sanitized terminal result",
      runtime: "cli",
      progressSummary: "CLI stale progress",
      terminalSummary: "Exec denied (gateway id=req-1, approval-timeout): bash -lc ls",
      expected: "Command did not run: approval timed out.",
    },
    {
      label: "cron progress fallback",
      runtime: "cron",
      progressSummary: "Cron fallback result",
      terminalSummary: undefined,
      expected: "Cron fallback result",
    },
    {
      label: "cron blank-terminal fallback",
      runtime: "cron",
      progressSummary: "Cron blank-terminal fallback result",
      terminalSummary: "",
      preserveTerminalSummary: true,
      expected: "Cron blank-terminal fallback result",
    },
    {
      label: "CLI progress fallback",
      runtime: "cli",
      progressSummary: "CLI fallback result",
      terminalSummary: undefined,
      expected: "CLI fallback result",
    },
  ] as const)("returns the runtime-owned result for $label", async (fixture) => {
    const task = createTaskRecord({
      runtime: fixture.runtime,
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: fixture.label,
      status: "succeeded",
      deliveryStatus: "not_applicable",
      progressSummary: fixture.progressSummary,
      terminalSummary: fixture.terminalSummary,
    });
    if ("preserveTerminalSummary" in fixture) {
      expectDefined(
        markTaskTerminalById({
          taskId: task.taskId,
          status: "succeeded",
          endedAt: Date.now(),
          terminalSummary: fixture.terminalSummary,
          preserveTerminalSummary: fixture.preserveTerminalSummary,
        }),
        "expected preserved terminal summary task",
      );
    }

    const { payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.result).toBe(fixture.expected);
  });

  it("keeps bounded prompts lookup-only", async () => {
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: `Inspect the task prompt ${"x".repeat(5_000)}`,
      status: "running",
      deliveryStatus: "pending",
    });

    const listed = await runTaskHandler("tasks.list", {});
    expect(listed.payload?.tasks?.[0]?.prompt).toBeUndefined();

    const { payload } = await getTaskPayload(task.taskId);
    expect(payload?.task?.prompt).toHaveLength(4_000);
    expect(payload?.task?.prompt).toMatch(/^Inspect the task prompt/);
    expect(payload?.task?.prompt).toMatch(/…$/);
  });

  it("preserves prompt layout while removing internal runtime context", async () => {
    const visiblePrompt = [
      "Review this workflow:",
      "",
      "  ```yaml",
      "  steps:",
      "    - test",
      "  ```",
    ].join("\n");
    const task = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: `${visiblePrompt}\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nhidden\n${INTERNAL_RUNTIME_CONTEXT_END}`,
      status: "running",
      deliveryStatus: "pending",
    });

    const { payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.prompt).toBe(visiblePrompt);
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
    emitAgentEvent({
      runId: "run-sanitized",
      stream: "assistant",
      data: { text: "OpenClaw runtime context (internal): Keep internal details private." },
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
    expect(payload?.task).not.toHaveProperty("lastActivity");
    expect(payload?.task?.prompt).toBe("Compile artifact");
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

  it("projects isolated live subagent activity and best-effort diff stats", async () => {
    const primary = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:primary",
      runId: "run-live-primary",
      task: "Implement task activity",
      status: "running",
      deliveryStatus: "not_applicable",
      progressSummary: "Milestone remains authoritative",
    });
    const secondary = createTaskRecord({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:secondary",
      runId: "run-live-secondary",
      task: "Review task activity",
      status: "running",
      deliveryStatus: "not_applicable",
    });
    const longLastLine = `Updating   files ${"x".repeat(220)}`;
    const emitPrimaryTool = (data: Record<string, unknown>) =>
      emitAgentEvent({ runId: primary.runId!, stream: "tool", data });

    emitAgentEvent({
      runId: primary.runId!,
      stream: "thinking",
      data: { text: "Inspecting the fold\nThinking fallback" },
    });
    emitAgentEvent({
      runId: secondary.runId!,
      stream: "thinking",
      data: { text: "Checking isolation\n  Thinking-only   progress  " },
    });
    emitAgentEvent({
      runId: primary.runId!,
      stream: "assistant",
      data: { text: `Earlier line\n\n${longLastLine}` },
    });
    emitAgentEvent({
      runId: primary.runId!,
      stream: "thinking",
      data: { text: "Later thinking must not replace assistant activity" },
    });
    emitPrimaryTool({
      phase: "start",
      name: "edit",
      toolCallId: "edit-1",
      args: {
        path: "src/a.ts",
        edits: [{ oldText: "one\ntwo", newText: "one\nthree\nfour" }],
      },
    });
    emitPrimaryTool({ phase: "result", name: "edit", toolCallId: "edit-1", isError: false });
    emitPrimaryTool({
      phase: "start",
      name: "write",
      toolCallId: "write-1",
      args: { file_path: "src/b.ts", content: "alpha\nbeta" },
    });
    emitPrimaryTool({ phase: "result", name: "write", toolCallId: "write-1", isError: false });
    emitPrimaryTool({
      phase: "start",
      name: "apply_patch",
      toolCallId: "patch-1",
      args: {
        input: [
          "*** Begin Patch",
          "*** Update File: src/a.ts",
          "@@",
          "-old",
          "+new",
          "+newer",
          "*** Delete File: src/c.ts",
          "*** End Patch",
        ].join("\n"),
      },
    });
    emitPrimaryTool({
      phase: "result",
      name: "apply_patch",
      toolCallId: "patch-1",
      isError: false,
    });
    emitPrimaryTool({
      phase: "start",
      name: "write",
      toolCallId: "write-failed",
      args: { path: "src/ignored.ts", content: "not\ncounted" },
    });
    emitPrimaryTool({ phase: "result", name: "write", toolCallId: "write-failed", isError: true });

    const primaryGet = await getTaskPayload(primary.taskId);
    const secondaryGet = await getTaskPayload(secondary.taskId);
    const listed = await runTaskHandler("tasks.list", {});
    const listedPrimary = listed.payload?.tasks?.find((task) => task.id === primary.taskId);

    expect(primaryGet.payload?.task?.lastActivity).toMatch(/^Updating files x+…$/);
    expect(String(primaryGet.payload?.task?.lastActivity).length).toBeLessThanOrEqual(200);
    expect(primaryGet.payload?.task?.diffStat).toEqual({ files: 3, added: 7, removed: 3 });
    expect(primaryGet.payload?.task?.progressSummary).toBe("Milestone remains authoritative");
    expect(secondaryGet.payload?.task?.lastActivity).toBe("Thinking-only progress");
    expect(secondaryGet.payload?.task).not.toHaveProperty("diffStat");
    expect(listedPrimary?.lastActivity).toBe(primaryGet.payload?.task?.lastActivity);
    expect(listedPrimary?.diffStat).toEqual(primaryGet.payload?.task?.diffStat);

    markTaskTerminalById({ taskId: primary.taskId, status: "succeeded", endedAt: Date.now() });
    const terminal = await getTaskPayload(primary.taskId);
    expect(terminal.payload?.task).not.toHaveProperty("lastActivity");
    expect(terminal.payload?.task).not.toHaveProperty("diffStat");
    expect(terminal.payload?.task?.progressSummary).toBe("Milestone remains authoritative");
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
      expectedRunId: "run-cancel-acp-gateway",
    });
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(true);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("cancelled");
    expect(getTaskById(task.taskId)?.status).toBe("cancelled");
    expect(getTaskById(siblingTask.taskId)?.status).toBe("cancelled");
    expect(getTaskById(siblingTask.taskId)?.error).toBe("operator requested stop");
  });

  it.each([
    ["tasks.retry", "task has no recoverable subagent completion"],
    ["tasks.dismiss", "completion delivery is not blocked"],
  ] as const)("returns one visible refusal per missing task for %s", async (method, reason) => {
    const { calls, payload } = await runTaskHandler(method, {
      taskIds: ["missing-one", "missing-two"],
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.results).toEqual([
      {
        taskId: "missing-one",
        ok: false,
        reason,
      },
      {
        taskId: "missing-two",
        ok: false,
        reason,
      },
    ]);
  });
});
