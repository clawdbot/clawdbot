// Covers task registry lifecycle, delivery, notification, and query behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import { startAcpSpawnParentStreamRelay } from "../agents/acp-spawn-parent-stream.js";
import { emitAcpLifecycleStart } from "../agents/command/attempt-execution.js";
import { resetCronActiveJobs } from "../cron/active-jobs.js";
import {
  emitAgentEvent,
  registerAgentRunContext,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import {
  requestHeartbeat,
  setHeartbeatWakeHandler,
  type HeartbeatWakeRequest,
} from "../infra/heartbeat-wake.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import { ensureTaskRuntimeStateReady } from "./runtime-internal.js";
import {
  createTaskFlowForTask as createTaskFlowForTaskOrNull,
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  getTaskFlowById,
  requestFlowCancel,
} from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  cancelTaskById,
  deleteTaskRecordById,
  finalizeTaskRunByRunId,
  findTaskByRunId,
  getTaskById,
  isParentFlowLinkError,
  listTasksForAgentId,
  listTasksForOwnerKey,
  listTasksForRelatedSessionKey,
  listTaskRecords,
  linkTaskToFlowById,
  maybeDeliverTaskTerminalUpdate,
  markTaskRunningByRunId,
  markTaskTerminalById,
  recordTaskProgressByRunId,
  reloadTaskRegistryFromStore,
  resolveTaskForLookupToken,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import {
  configureTaskRegistryMaintenance,
  getInspectableTaskAuditFindings,
  getInspectableTaskRegistrySummary,
  getInspectableTaskAuditSummary,
  previewTaskRegistryMaintenance,
  resetTaskRegistryMaintenanceRuntimeForTests,
  reconcileInspectableTasks,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceRuntimeForTests,
  startTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
  sweepTaskRegistry,
} from "./task-registry.maintenance.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import { createAcpTaskRecord, createTaskFixture } from "./task-registry.test-support.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  maybeDeliverTaskStateChangeUpdate,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "./task-runtime.test-helpers.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOST_TASK_RETENTION_MS = 24 * 60 * 60_000;
const NOTIFYCHAT_ORIGIN = { channel: "notifychat", to: "notifychat:123" } as const;
const GUILDCHAT_ORIGIN = { channel: "guildchat", to: "guildchat:123" } as const;

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function createTaskFlowForTask(
  params: Parameters<typeof createTaskFlowForTaskOrNull>[0],
): TaskFlowRecord {
  const flow = createTaskFlowForTaskOrNull(params);
  if (!flow) {
    throw new Error("expected task-mirrored TaskFlow creation to succeed");
  }
  return flow;
}

const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const cancelBackgroundExecSessionMock = vi.fn();
  const cancelActiveCronTaskRunMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  return {
    sendMessageMock,
    cancelSessionMock,
    cancelBackgroundExecSessionMock,
    cancelActiveCronTaskRunMock,
    killSubagentRunAdminMock,
  };
});

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length;
}

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) =>
    channel === "notifychat" || channel === "guildchat" || channel === "discord",
}));

function configureTaskRegistryMaintenanceRuntimeForTest(params: {
  currentTasks: Map<string, ReturnType<typeof createTaskFixture>>;
  snapshotTasks: ReturnType<typeof createTaskFixture>[];
  listTaskRecords?: () => ReturnType<typeof createTaskFixture>[];
  acpEntry?: AcpSessionStoreEntry;
  acpEntries?: AcpSessionStoreEntry[];
  listAcpSessionEntries?: () => Promise<AcpSessionStoreEntry[]>;
  hasActiveAcpTurn?: (sessionKey: string) => boolean;
  isBackgroundExecSessionActive?: (sessionId: string) => boolean;
  sessionBindings?: SessionBindingRecord[];
  closeAcpSession?: (params: {
    cfg: AcpSessionStoreEntry["cfg"];
    sessionKey: string;
    reason: string;
  }) => Promise<void>;
  unbindSessionBindings?: (params: {
    targetSessionKey?: string;
    bindingId?: string;
    reason: string;
  }) => Promise<SessionBindingRecord[]>;
}): void {
  const emptyAcpEntry = {
    cfg: {} as never,
    storePath: "",
    sessionKey: "",
    storeSessionKey: "",
    entry: undefined,
    storeReadFailed: false,
  } satisfies AcpSessionStoreEntry;
  setTaskRegistryMaintenanceRuntimeForTests({
    listAcpSessionEntries: params.listAcpSessionEntries ?? (async () => params.acpEntries ?? []),
    readAcpSessionEntry: () => params.acpEntry ?? emptyAcpEntry,
    listSessionBindingsBySession: () => params.sessionBindings ?? [],
    closeAcpSession: params.closeAcpSession,
    unbindSessionBindings: params.unbindSessionBindings,
    listSessionEntries: () => [],
    resolveStorePath: () => "",
    parseAgentSessionKey: () => null as ParsedAgentSessionKey | null,
    isCronJobActive: () => false,
    getAgentRunContext: () => undefined,
    isBackgroundExecSessionActive: params.isBackgroundExecSessionActive,
    hasActiveAcpTurn: params.hasActiveAcpTurn ?? (() => false),
    hasActiveTaskForChildSessionKey: ({ sessionKey, excludeTaskId }) => {
      const normalized = sessionKey.trim().toLowerCase();
      return Array.from(params.currentTasks.values()).some(
        (task) =>
          task.taskId !== excludeTaskId &&
          (task.status === "queued" || task.status === "running") &&
          task.childSessionKey?.trim().toLowerCase() === normalized,
      );
    },
    deleteTaskRecordById: (taskId: string) => params.currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => params.currentTasks.get(taskId),
    listTaskRecords: params.listTaskRecords ?? (() => params.snapshotTasks),
    markTaskLostById: (patch: {
      taskId: string;
      endedAt: number;
      lastEventAt?: number;
      error?: string;
      cleanupAfter?: number;
    }) => {
      const current = params.currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        status: "lost" as const,
        endedAt: patch.endedAt,
        lastEventAt: patch.lastEventAt ?? patch.endedAt,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.cleanupAfter !== undefined ? { cleanupAfter: patch.cleanupAfter } : {}),
      };
      params.currentTasks.set(patch.taskId, next);
      return next;
    },
    markTaskTerminalById: () => null,
    maybeDeliverTaskTerminalUpdate: async () => null,
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: (patch: { taskId: string; cleanupAfter: number }) => {
      const current = params.currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        cleanupAfter: patch.cleanupAfter,
      };
      params.currentTasks.set(patch.taskId, next);
      return next;
    },
    isRuntimeAuthoritative: () => true,
    listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: () => [],
  });
}

function createSessionBindingRecord(
  overrides: Partial<SessionBindingRecord> & Pick<SessionBindingRecord, "targetSessionKey">,
): SessionBindingRecord {
  return {
    bindingId: overrides.bindingId ?? "binding-1",
    targetSessionKey: overrides.targetSessionKey,
    targetKind: overrides.targetKind ?? "session",
    conversation: overrides.conversation ?? {
      channel: "telegram",
      accountId: "default",
      conversationId: "telegram:thread:1",
    },
    status: overrides.status ?? "active",
    boundAt: overrides.boundAt ?? Date.now(),
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
}

function createAcpSessionStoreEntry(params: {
  sessionKey: string;
  parentSessionKey: string;
  mode: "persistent" | "oneshot";
}): AcpSessionStoreEntry {
  const acp = {
    backend: "acpx",
    agent: "claude",
    runtimeSessionName: `${params.sessionKey}:runtime`,
    mode: params.mode,
    state: "idle",
    lastActivityAt: Date.now(),
  } as const;
  return {
    cfg: {} as never,
    storePath: "/tmp/openclaw-test-sessions.json",
    sessionKey: params.sessionKey,
    storeSessionKey: params.sessionKey,
    entry: {
      sessionId: `${params.sessionKey}:session`,
      updatedAt: Date.now(),
      spawnedBy: params.parentSessionKey,
      acp,
    },
    acp,
    storeReadFailed: false,
  };
}

function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 5) {
  return waitForFast(assertion, { timeout: timeoutMs, interval: stepMs });
}

async function flushAsyncWork(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function requireTaskByRunId(runId: string): TaskRecord {
  const task = findTaskByRunId(runId);
  if (!task) {
    throw new Error(`Expected task for run ${runId}`);
  }
  return task;
}

function requireTaskById(taskId: string): TaskRecord {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error(`Expected task ${taskId}`);
  }
  return task;
}

function sentMessageCall(callIndex = 0): Record<string, unknown> {
  const call = hoisted.sendMessageMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected sendMessage call ${callIndex}`);
  }
  return call[0] as Record<string, unknown>;
}

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`Expected ${label} call`);
  }
  return expectRecordFields(call[0], {});
}

const cancelTask = (taskId: string) => cancelTaskById({ cfg: {} as never, taskId });

function finalizeSubagentTask(
  task: TaskRecord,
  params: Omit<Parameters<typeof finalizeTaskRunByRunId>[0], "runId" | "runtime">,
) {
  return finalizeTaskRunByRunId({ runId: task.runId!, runtime: "subagent", ...params });
}

function createInMemoryTaskRegistryStore() {
  const tasks = new Map<string, TaskRecord>();
  const deliveryStates = new Map<string, TaskDeliveryState>();
  return {
    loadSnapshot: () => ({
      tasks: new Map(tasks),
      deliveryStates: new Map(deliveryStates),
    }),
    saveSnapshot: (snapshot: {
      tasks: Map<string, TaskRecord>;
      deliveryStates: Map<string, TaskDeliveryState>;
    }) => {
      tasks.clear();
      deliveryStates.clear();
      for (const [taskId, task] of snapshot.tasks.entries()) {
        tasks.set(taskId, task);
      }
      for (const [taskId, state] of snapshot.deliveryStates.entries()) {
        deliveryStates.set(taskId, state);
      }
    },
    upsertTaskWithDeliveryState: (params: {
      task: TaskRecord;
      deliveryState?: TaskDeliveryState;
    }) => {
      tasks.set(params.task.taskId, params.task);
      if (params.deliveryState) {
        deliveryStates.set(params.deliveryState.taskId, params.deliveryState);
      } else {
        deliveryStates.delete(params.task.taskId);
      }
    },
    upsertTask: (task: TaskRecord) => {
      tasks.set(task.taskId, task);
    },
    deleteTaskWithDeliveryState: (taskId: string) => {
      tasks.delete(taskId);
      deliveryStates.delete(taskId);
    },
    deleteTask: (taskId: string) => {
      tasks.delete(taskId);
      deliveryStates.delete(taskId);
    },
    upsertDeliveryState: (state: TaskDeliveryState) => {
      deliveryStates.set(state.taskId, state);
    },
    deleteDeliveryState: (taskId: string) => {
      deliveryStates.delete(taskId);
    },
    close: () => {},
  };
}

function createInMemoryTaskFlowRegistryStore() {
  const flows = new Map<string, TaskFlowRecord>();
  return {
    loadSnapshot: () => ({
      flows: new Map(flows),
    }),
    saveSnapshot: (snapshot: { flows: Map<string, TaskFlowRecord> }) => {
      flows.clear();
      for (const [flowId, flow] of snapshot.flows.entries()) {
        flows.set(flowId, flow);
      }
    },
    upsertFlow: (flow: TaskFlowRecord) => {
      flows.set(flow.flowId, flow);
    },
    deleteFlow: (flowId: string) => {
      flows.delete(flowId);
    },
    close: () => {},
  };
}

function configureInMemoryTaskStoresForTests() {
  configureTaskRegistryRuntime({
    store: createInMemoryTaskRegistryStore(),
  });
  configureTaskFlowRegistryRuntime({
    store: createInMemoryTaskFlowRegistryStore(),
  });
}

function resetTaskRegistryMemoryForTest(opts?: { persist?: boolean }) {
  resetTaskRegistryForTests(opts);
  configureTaskRegistryRuntime({
    store: createInMemoryTaskRegistryStore(),
  });
}

async function withTaskRegistryTempDir<T>(
  run: (root: string) => Promise<T>,
  options?: { durableStore?: boolean },
): Promise<T> {
  return await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
    return await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      if (options?.durableStore !== true) {
        configureInMemoryTaskStoresForTests();
      }
      try {
        return await run(root);
      } finally {
        // Close both sqlite-backed registries before Windows temp-dir cleanup tries to remove them.
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    });
  });
}

const HEARTBEAT_FLUSH_REASON = "task-registry-test-flush";
let heartbeatWakeRequests: HeartbeatWakeRequest[] = [];
let clearHeartbeatWakeHandler: (() => void) | undefined;

async function flushHeartbeatWakeRequests(): Promise<void> {
  requestHeartbeat({
    source: "other",
    intent: "immediate",
    reason: HEARTBEAT_FLUSH_REASON,
    coalesceMs: 0,
  });
  await waitForFast(() => {
    expect(heartbeatWakeRequests.some((request) => request.reason === HEARTBEAT_FLUSH_REASON)).toBe(
      true,
    );
  });
}

function expectHeartbeatWake(
  source: "background-task" | "background-task-blocked",
  sessionKey: string,
) {
  expect(heartbeatWakeRequests).toContainEqual(
    expect.objectContaining({ source, reason: source, sessionKey }),
  );
}

describe("task-registry", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    heartbeatWakeRequests = [];
    clearHeartbeatWakeHandler = setHeartbeatWakeHandler(async (request) => {
      heartbeatWakeRequests.push(request);
      return { status: "ran", durationMs: 0 };
    });
    await flushHeartbeatWakeRequests();
    heartbeatWakeRequests = [];
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage: hoisted.sendMessageMock,
    });
    setTaskRegistryControlRuntimeForTests({
      cancelBackgroundExecSession: (sessionId) =>
        hoisted.cancelBackgroundExecSessionMock(sessionId),
      cancelActiveCronTaskRun: (params) => hoisted.cancelActiveCronTaskRunMock(params),
      getAcpSessionManager: () => ({
        cancelSession: hoisted.cancelSessionMock,
      }),
      killSubagentRunAdmin: async (params) => hoisted.killSubagentRunAdminMock(params),
    });
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    await flushHeartbeatWakeRequests();
    clearHeartbeatWakeHandler?.();
    clearHeartbeatWakeHandler = undefined;
    resetSystemEventsForTest();
    resetAgentEventsForTest({ preserveListeners: true });
    resetCronActiveJobs();
    resetTaskRegistryControlRuntimeForTests();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryMaintenanceRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    hoisted.sendMessageMock.mockReset();
    hoisted.cancelSessionMock.mockReset();
    hoisted.cancelBackgroundExecSessionMock.mockReset();
    hoisted.cancelActiveCronTaskRunMock.mockReset();
    hoisted.killSubagentRunAdminMock.mockReset();
  });

  it("updates task status from lifecycle events", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createTaskFixture("acp", {
        childSessionKey: "agent:main:acp:child",
        runId: "run-1",
        task: "Do the thing",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-1",
        stream: "assistant",
        data: {
          text: "working",
        },
      });
      emitAgentEvent({
        runId: "run-1",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      expectRecordFields(requireTaskByRunId("run-1"), {
        runtime: "acp",
        status: "succeeded",
        endedAt: 250,
      });
    });
  });

  it.each([
    {
      name: "persists an ACP producer timestamp across lifecycle projection and SQLite reload",
      runId: "run-reused-lifecycle",
      task: "Reuse a persisted task row",
      initialStatus: "queued" as const,
      lastEventAt: 1_000,
      lifecycleStartedAt: 2_000,
      terminalStartedAt: undefined,
      endedAt: 2_500,
      expectedStartedAt: 2_000,
    },
    {
      name: "persists an accepted zero lifecycle start timestamp over stale state",
      runId: "run-zero-lifecycle",
      task: "Replace a stale task timestamp",
      initialStatus: "queued" as const,
      lastEventAt: undefined,
      lifecycleStartedAt: 0,
      terminalStartedAt: undefined,
      endedAt: 500,
      expectedStartedAt: 0,
    },
    {
      name: "ignores a non-finite lifecycle timestamp during durable terminal projection",
      runId: "run-non-finite-terminal",
      task: "Keep the accepted producer timestamp",
      initialStatus: undefined,
      lastEventAt: undefined,
      lifecycleStartedAt: undefined,
      terminalStartedAt: Number.NaN,
      endedAt: 1_500,
      expectedStartedAt: 1_000,
    },
  ])(
    "$name",
    async ({
      runId,
      task,
      initialStatus,
      lastEventAt,
      lifecycleStartedAt,
      terminalStartedAt,
      endedAt,
      expectedStartedAt,
    }) => {
      await withTaskRegistryTempDir(
        async () => {
          resetTaskRegistryForTests({ persist: false });
          createTaskFixture("acp", {
            requesterSessionKey: "agent:main:main",
            runId,
            task,
            notifyPolicy: "silent",
            startedAt: 1_000,
            ...(initialStatus === undefined ? {} : { status: initialStatus }),
            ...(lastEventAt === undefined ? {} : { lastEventAt }),
          });

          if (lifecycleStartedAt !== undefined) {
            emitAcpLifecycleStart({ runId, startedAt: lifecycleStartedAt });
          }
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: {
              phase: "end",
              endedAt,
              ...(terminalStartedAt === undefined ? {} : { startedAt: terminalStartedAt }),
            },
          });

          resetTaskRegistryForTests({ persist: false });
          reloadTaskRegistryFromStore();
          expectRecordFields(requireTaskByRunId(runId), {
            status: "succeeded",
            startedAt: expectedStartedAt,
            endedAt,
          });
        },
        { durableStore: true },
      );
    },
  );

  it("tracks tool activity from tool-start events", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createTaskFixture("subagent", {
        childSessionKey: "agent:main:subagent:tools",
        runId: "run-tools",
        task: "Sweep the repo",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-tools",
        stream: "tool",
        data: { phase: "start", name: "read", toolCallId: "call-1" },
      });
      emitAgentEvent({
        runId: "run-tools",
        stream: "tool",
        data: { phase: "end", name: "read", toolCallId: "call-1" },
      });
      emitAgentEvent({
        runId: "run-tools",
        stream: "tool",
        data: { phase: "start", name: "exec", toolCallId: "call-2" },
      });
      // Nameless starts refresh lastEventAt but must not count as activity.
      emitAgentEvent({
        runId: "run-tools",
        stream: "tool",
        data: { phase: "start", toolCallId: "call-3" },
      });

      expectRecordFields(requireTaskByRunId("run-tools"), {
        toolUseCount: 2,
        lastToolName: "exec",
      });
    });
  });

  it("keeps subagent abort lifecycle projections provisional", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      createTaskFixture("subagent", {
        childSessionKey: "agent:main:subagent:abort-race",
        runId: "run-subagent-abort-race",
        task: "Finish while aborting",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-subagent-abort-race",
        stream: "lifecycle",
        data: { phase: "end", stopReason: "aborted", endedAt: 200 },
      });
      expectRecordFields(requireTaskByRunId("run-subagent-abort-race"), {
        status: "cancelled",
        error: SUBAGENT_KILL_TASK_ERROR,
      });

      finalizeTaskRunByRunId({
        runId: "run-subagent-abort-race",
        runtime: "subagent",
        status: "succeeded",
        endedAt: 201,
        terminalSummary: "finished",
      });
      expectRecordFields(requireTaskByRunId("run-subagent-abort-race"), {
        status: "succeeded",
        endedAt: 201,
        error: undefined,
        terminalSummary: "finished",
      });
    });
  });

  it("clears a provisional child session when the terminal outcome has none", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      createTaskFixture("cron", {
        ownerKey: "",
        scopeKind: "system",
        childSessionKey: "agent:main:cron:provisional",
        runId: "cron:provisional:100",
        task: "Provisional cron run",
        startedAt: 100,
      });

      finalizeTaskRunByRunId({
        runId: "cron:provisional:100",
        runtime: "cron",
        childSessionKey: null,
        status: "failed",
        endedAt: 200,
        error: "setup failed",
      });
      reloadTaskRegistryFromStore();

      expect(requireTaskByRunId("cron:provisional:100").childSessionKey).toBeUndefined();
    });
  });

  it("reuses an ACP run task when a derived flow id is linked before a duplicate create", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForTests();

      const first = createTaskFixture("acp", {
        ownerKey: "agent:jarvis:main",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-acp-derived-flow-dedupe",
        label: "original ACP task",
        task: "Run ACP child",
        notifyPolicy: "silent",
      });
      const flow = createTaskFlowForTask({ task: first });
      const linked = linkTaskToFlowById({
        taskId: first.taskId,
        flowId: flow.flowId,
      });
      expect(linked?.parentFlowId).toBe(flow.flowId);

      const duplicateCreate = createTaskFixture("acp", {
        ownerKey: "agent:jarvis:main",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-acp-derived-flow-dedupe",
        label: "late ACP mirror",
        task: "Late mirror of the same ACP child",
        deliveryStatus: "pending",
        notifyPolicy: "silent",
      });

      expect(duplicateCreate.taskId).toBe(first.taskId);
      expect(listTaskRecords().filter((task) => task.runId === first.runId)).toHaveLength(1);
    });
  });

  it("ignores late agent events for operator-cancelled tasks", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      const task = createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-cancel-then-end",
        task: "Do the thing",
        startedAt: 100,
      });

      markTaskTerminalById({
        taskId: task.taskId,
        status: "cancelled",
        endedAt: 200,
        lastEventAt: 200,
        error: "Cancelled by operator.",
      });

      emitAgentEvent({
        runId: "run-cancel-then-end",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 999,
        },
      });
      emitAgentEvent({
        runId: "run-cancel-then-end",
        stream: "error",
        data: {
          error: "late error",
        },
      });

      expectRecordFields(requireTaskByRunId("run-cancel-then-end"), {
        status: "cancelled",
        endedAt: 200,
        lastEventAt: 200,
        error: "Cancelled by operator.",
      });
    });
  });

  it("clears terminal errors when explicitly updated without an error", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskFixture("cron", {
        ownerKey: "system:cron:test",
        scopeKind: "system",
        runId: "run-terminal-error-clear",
        task: "Recover cron task",
        startedAt: 100,
      });

      markTaskTerminalById({
        taskId: task.taskId,
        status: "failed",
        endedAt: 200,
        error: "backing session missing",
      });
      markTaskTerminalById({
        taskId: task.taskId,
        status: "succeeded",
        endedAt: 250,
        error: undefined,
      });

      const recoveredTask = getTaskById(task.taskId);
      expect(recoveredTask).toMatchObject({
        status: "succeeded",
        endedAt: 250,
      });
      expect(recoveredTask).not.toHaveProperty("error");
    });
  });

  it("recovers only direct subagent kill markers when completion wins the race", async () => {
    await withTaskRegistryTempDir(async () => {
      for (const entry of [
        {
          runId: "run-subagent-late-success",
          runtime: "subagent" as const,
          childSessionKey: "agent:main:subagent:late-success",
          error: SUBAGENT_KILL_TASK_ERROR,
          terminalStatus: "succeeded" as const,
          terminalError: undefined,
          expectedError: undefined,
        },
        {
          runId: "run-subagent-late-failure",
          runtime: "subagent" as const,
          childSessionKey: "agent:main:subagent:late-failure",
          error: SUBAGENT_KILL_TASK_ERROR,
          terminalStatus: "failed" as const,
          terminalError: "provider failed",
          expectedError: "provider failed",
        },
        {
          runId: "run-subagent-late-timeout",
          runtime: "subagent" as const,
          childSessionKey: "agent:main:subagent:late-timeout",
          error: SUBAGENT_KILL_TASK_ERROR,
          terminalStatus: "timed_out" as const,
          terminalError: undefined,
          expectedError: undefined,
        },
        {
          runId: "run-acp-late-success",
          runtime: "acp" as const,
          childSessionKey: "agent:main:acp:late-success",
          error: "Task cancellation requested.",
          terminalStatus: "succeeded" as const,
          terminalError: undefined,
          expectedError: "Task cancellation requested.",
        },
      ]) {
        createTaskFixture(entry.runtime, {
          childSessionKey: entry.childSessionKey,
          runId: entry.runId,
          task: entry.runId,
        });
        finalizeTaskRunByRunId({
          runId: entry.runId,
          runtime: entry.runtime,
          status: "cancelled",
          endedAt: 200,
          error: entry.error,
        });
        finalizeTaskRunByRunId({
          runId: entry.runId,
          runtime: entry.runtime,
          status: entry.terminalStatus,
          endedAt: 201,
          error: entry.terminalError,
          terminalSummary: "completed",
        });

        const task = requireTaskByRunId(entry.runId);
        expect(task.status).toBe(entry.runtime === "acp" ? "cancelled" : entry.terminalStatus);
        expect(task.error).toBe(entry.expectedError);
      }
    });
  });

  it("keeps stronger run-scoped terminal states when a late success arrives", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-timeout-then-success",
        task: "Do the thing",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-timeout-then-success",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 200,
          aborted: true,
        },
      });
      finalizeTaskRunByRunId({
        runId: "run-timeout-then-success",
        runtime: "cli",
        status: "succeeded",
        endedAt: 300,
        terminalSummary: "completed",
      });

      expectRecordFields(requireTaskByRunId("run-timeout-then-success"), {
        status: "timed_out",
        endedAt: 200,
      });
    });
  });

  it("uses shared agent terminal precedence for lifecycle task projection", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-hard-timeout-task",
        task: "Provider timeout should not look cancelled",
        startedAt: 100,
      });
      createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-rpc-cancel-task",
        task: "Caller abort should cancel task",
        startedAt: 100,
      });
      createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-aborted-task",
        task: "Aborted runner stop should cancel task",
        startedAt: 100,
      });
      createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-provider-error-timeout-task",
        task: "Provider timeout error should time out task",
        startedAt: 100,
      });
      createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-provider-end-timeout-task",
        task: "Provider timeout end metadata should time out task",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-hard-timeout-task",
        stream: "lifecycle",
        data: {
          phase: "end",
          aborted: true,
          stopReason: "rpc",
          timeoutPhase: "provider",
          providerStarted: true,
          endedAt: 200,
        },
      });
      emitAgentEvent({
        runId: "run-rpc-cancel-task",
        stream: "lifecycle",
        data: {
          phase: "end",
          aborted: true,
          stopReason: "rpc",
          timeoutPhase: "queue",
          providerStarted: false,
          endedAt: 210,
        },
      });
      emitAgentEvent({
        runId: "run-aborted-task",
        stream: "lifecycle",
        data: {
          phase: "end",
          stopReason: "aborted",
          endedAt: 220,
        },
      });
      emitAgentEvent({
        runId: "run-provider-error-timeout-task",
        stream: "lifecycle",
        data: {
          phase: "error",
          error: "provider request timed out",
          livenessState: "blocked",
          timeoutPhase: "provider",
          providerStarted: true,
          endedAt: 230,
        },
      });
      emitAgentEvent({
        runId: "run-provider-end-timeout-task",
        stream: "lifecycle",
        data: {
          phase: "end",
          timeoutPhase: "provider",
          providerStarted: true,
          endedAt: 240,
        },
      });

      expectRecordFields(requireTaskByRunId("run-hard-timeout-task"), {
        status: "timed_out",
        endedAt: 200,
      });
      expectRecordFields(requireTaskByRunId("run-rpc-cancel-task"), {
        status: "cancelled",
        endedAt: 210,
      });
      expectRecordFields(requireTaskByRunId("run-aborted-task"), {
        status: "cancelled",
        endedAt: 220,
      });
      expectRecordFields(requireTaskByRunId("run-provider-error-timeout-task"), {
        status: "timed_out",
        endedAt: 230,
        error: "provider request timed out",
      });
      expectRecordFields(requireTaskByRunId("run-provider-end-timeout-task"), {
        status: "timed_out",
        endedAt: 240,
      });
    });
  });

  it("does not downgrade failed run-scoped tasks when a late success arrives", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-fail-then-success",
        task: "Deliver result",
        startedAt: 100,
      });

      finalizeTaskRunByRunId({
        runId: "run-fail-then-success",
        runtime: "cli",
        status: "failed",
        endedAt: 200,
        error: "delivery failed",
      });
      finalizeTaskRunByRunId({
        runId: "run-fail-then-success",
        runtime: "cli",
        status: "succeeded",
        endedAt: 300,
        terminalSummary: "completed",
      });

      expectRecordFields(requireTaskByRunId("run-fail-then-success"), {
        status: "failed",
        endedAt: 200,
        error: "delivery failed",
      });
    });
  });

  it("lets delivery failure upgrade a lifecycle success", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-success-then-fail",
        task: "Deliver result",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-success-then-fail",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 200,
        },
      });
      finalizeTaskRunByRunId({
        runId: "run-success-then-fail",
        runtime: "cli",
        status: "failed",
        endedAt: 300,
        error: "delivery failed",
      });

      expectRecordFields(requireTaskByRunId("run-success-then-fail"), {
        status: "failed",
        endedAt: 300,
        error: "delivery failed",
      });
    });
  });

  it("summarizes task pressure by status and runtime", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createTaskFixture("acp", {
        runId: "run-summary-acp",
        task: "Investigate issue",
        status: "queued",
        deliveryStatus: "pending",
      });
      createTaskFixture("cron", {
        ownerKey: "",
        scopeKind: "system",
        runId: "run-summary-cron",
        task: "Daily digest",
      });
      createTaskFixture("subagent", {
        runId: "run-summary-subagent",
        task: "Write patch",
        status: "timed_out",
        deliveryStatus: "session_queued",
      });

      expect(summarizeTaskRecords(listTaskRecords())).toEqual({
        total: 3,
        active: 2,
        terminal: 1,
        failures: 1,
        byStatus: {
          queued: 1,
          running: 1,
          succeeded: 0,
          failed: 0,
          timed_out: 1,
          cancelled: 0,
          lost: 0,
        },
        byRuntime: {
          subagent: 1,
          acp: 1,
          cli: 0,
          cron: 1,
        },
      });
    });
  });

  it.each([
    {
      name: "rejects cross-owner parent flow links during task creation",
      runtime: "acp" as const,
      params: {
        status: undefined,
        deliveryStatus: undefined,
        ownerKey: "agent:main:other",
        runId: "cross-owner-run",
        task: "Attempt hijack",
      },
      error: "Task ownerKey must match parent flow ownerKey.",
    },
    {
      name: "rejects system-scoped parent flow links during task creation",
      runtime: "cron" as const,
      params: {
        status: undefined,
        scopeKind: "system" as const,
        runId: "system-link-run",
        task: "System task",
      },
      error: "Only session-scoped tasks can link to flows.",
    },
  ])("$name", async ({ runtime, params, error }) => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForTests();
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-registry",
        goal: "Owner main flow",
      });

      expect(() => createTaskFixture(runtime, { ...params, parentFlowId: flow.flowId })).toThrow(
        error,
      );
    });
  });

  it("rejects cross-owner flow links for existing tasks", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForTests();

      const task = createTaskFixture("acp", {
        status: undefined,
        deliveryStatus: undefined,
        runId: "owner-main-task",
        task: "Safe task",
      });
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:other",
        controllerId: "tests/task-registry",
        goal: "Other owner flow",
      });

      expect(() =>
        linkTaskToFlowById({
          taskId: task.taskId,
          flowId: flow.flowId,
        }),
      ).toThrow("Task ownerKey must match parent flow ownerKey.");
      expectRecordFields(requireTaskById(task.taskId), {
        taskId: task.taskId,
        parentFlowId: undefined,
      });
    });
  });

  it("does not persist linked task changes while task-flow restore is failed", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      const taskStore = createInMemoryTaskRegistryStore();
      const taskUpsert = vi.spyOn(taskStore, "upsertTaskWithDeliveryState");
      const taskDelete = vi.spyOn(taskStore, "deleteTaskWithDeliveryState");
      const deliveryUpsert = vi.spyOn(taskStore, "upsertDeliveryState");
      configureTaskRegistryRuntime({ store: taskStore });
      configureTaskFlowRegistryRuntime({
        store: createInMemoryTaskFlowRegistryStore(),
      });

      const task = createTaskFixture("acp", {
        deliveryStatus: undefined,
        runId: "flow-restore-failed-task",
        task: "Preserve linked task state",
      });
      const flow = createTaskFlowForTask({ task });
      expect(
        linkTaskToFlowById({
          taskId: task.taskId,
          flowId: flow.flowId,
        })?.parentFlowId,
      ).toBe(flow.flowId);
      taskUpsert.mockClear();
      deliveryUpsert.mockClear();

      resetTaskFlowRegistryForTests({ persist: false });
      const loadSnapshot = vi.fn(() => {
        throw new Error("SQLITE_IOERR: task-flow restore failed");
      });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot,
          saveSnapshot: () => {},
        },
      });

      expect(() =>
        markTaskTerminalById({
          taskId: task.taskId,
          status: "succeeded",
          endedAt: 200,
        }),
      ).toThrow("Task-flow registry restore failed: SQLITE_IOERR: task-flow restore failed");
      expect(taskUpsert).not.toHaveBeenCalled();
      expect(requireTaskById(task.taskId).status).toBe("running");

      expect(() => deleteTaskRecordById(task.taskId)).toThrow(
        "Task-flow registry restore failed: SQLITE_IOERR: task-flow restore failed",
      );
      expect(taskDelete).not.toHaveBeenCalled();
      expect(requireTaskById(task.taskId).taskId).toBe(task.taskId);

      expect(() =>
        createTaskFixture("acp", {
          deliveryStatus: undefined,
          requesterOrigin: NOTIFYCHAT_ORIGIN,
          runId: task.runId,
          task: task.task,
        }),
      ).toThrow("Task-flow registry restore failed: SQLITE_IOERR: task-flow restore failed");
      expect(deliveryUpsert).not.toHaveBeenCalled();
      expect(loadSnapshot).toHaveBeenCalledTimes(1);

      const standalone = createTaskFixture("cli", {
        runId: "standalone-during-flow-restore-failure",
        task: "Keep standalone task state available",
      });
      expect(
        markTaskTerminalById({
          taskId: standalone.taskId,
          status: "succeeded",
          endedAt: 300,
        })?.status,
      ).toBe("succeeded");
    });
  });

  it("restores task-flow state before activating the task registry", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      const loadTaskSnapshot = vi.fn(() => ({
        tasks: new Map<string, TaskRecord>(),
        deliveryStates: new Map<string, TaskDeliveryState>(),
      }));
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: loadTaskSnapshot,
          saveSnapshot: () => {},
        },
      });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => {
            throw new Error("SQLITE_CORRUPT: task-flow startup restore failed");
          },
          saveSnapshot: () => {},
        },
      });

      expect(() => ensureTaskRuntimeStateReady()).toThrow(
        "Task-flow registry restore failed: SQLITE_CORRUPT: task-flow startup restore failed",
      );
      expect(loadTaskSnapshot).not.toHaveBeenCalled();
    });
  });

  it("propagates task registry restore failures through the runtime gate", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskFlowRegistryRuntime({
        store: createInMemoryTaskFlowRegistryStore(),
      });
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => {
            throw new Error("SQLITE_IOERR: task startup restore failed");
          },
          saveSnapshot: () => {},
        },
      });

      expect(() => ensureTaskRuntimeStateReady()).toThrow(
        "Task registry restore failed: SQLITE_IOERR: task startup restore failed",
      );
    });
  });

  it("reports task update success and retries when task-mirrored flow sync persistence fails", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForTests();

      const task = createTaskFixture("acp", {
        deliveryStatus: undefined,
        runId: "mirrored-flow-sync-fail",
        task: "Sync mirrored flow",
        lastEventAt: 100,
      });
      const flow = createTaskFlowForTask({ task });
      const linked = linkTaskToFlowById({
        taskId: task.taskId,
        flowId: flow.flowId,
      });
      expect(linked?.parentFlowId).toBe(flow.flowId);

      let remainingUpsertFailures = 2;
      const admittedRetryCounts: number[] = [];
      const upsertFlow = vi.fn(() => {
        if (upsertFlow.mock.calls.length > 1) {
          admittedRetryCounts.push(getActiveGatewayRootWorkCount());
        }
        if (remainingUpsertFailures > 0) {
          remainingUpsertFailures -= 1;
          throw new Error("SQLITE_FULL: database or disk is full");
        }
      });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            flows: new Map(),
          }),
          saveSnapshot: () => {},
          upsertFlow,
        },
      });

      const updated = markTaskTerminalById({
        taskId: task.taskId,
        status: "succeeded",
        endedAt: 200,
        terminalSummary: "Done",
      });

      expect(updated?.status).toBe("succeeded");
      const currentTask = requireTaskById(task.taskId);
      expect(currentTask.status).toBe("succeeded");
      expect(getTaskFlowById(flow.flowId)?.status).toBe("running");

      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsyncWork();
      expect(getTaskFlowById(flow.flowId)?.status).toBe("running");
      expect(upsertFlow).toHaveBeenCalledTimes(2);
      expect(admittedRetryCounts).toEqual([1]);

      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsyncWork();

      expect(upsertFlow).toHaveBeenCalledTimes(2);
      expect(getActiveGatewayRootWorkCount()).toBe(0);

      expect(suspension?.release()).toBe(true);
      await flushAsyncWork();

      expect(upsertFlow).toHaveBeenCalledTimes(3);
      expect(admittedRetryCounts).toEqual([1, 1]);
      const retriedFlow = getTaskFlowById(flow.flowId);
      expect(retriedFlow?.status).toBe("succeeded");
      expect(retriedFlow?.endedAt).toBe(200);
    });
  });

  it("does not let a delayed task-mirrored flow sync retry overwrite a newer linked task", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForTests();

      const task = createTaskFixture("acp", {
        deliveryStatus: undefined,
        runId: "mirrored-flow-stale-retry",
        task: "Initial blocked task",
        lastEventAt: 100,
      });
      const flow = createTaskFlowForTask({ task });
      expect(
        linkTaskToFlowById({
          taskId: task.taskId,
          flowId: flow.flowId,
        })?.parentFlowId,
      ).toBe(flow.flowId);

      let failUpsert = true;
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            flows: new Map(),
          }),
          saveSnapshot: () => {},
          upsertFlow: () => {
            if (failUpsert) {
              throw new Error("SQLITE_BUSY: database is locked");
            }
          },
        },
      });

      expect(
        markTaskTerminalById({
          taskId: task.taskId,
          status: "succeeded",
          endedAt: 200,
          terminalOutcome: "blocked",
          terminalSummary: "Needs follow-up",
        })?.status,
      ).toBe("succeeded");
      expect(getTaskFlowById(flow.flowId)?.status).toBe("running");

      failUpsert = false;
      const newerTask = createTaskFixture("acp", {
        deliveryStatus: undefined,
        parentFlowId: flow.flowId,
        runId: "mirrored-flow-newer-task",
        task: "Retry task",
        lastEventAt: 250,
      });
      expect(newerTask.parentFlowId).toBe(flow.flowId);

      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsyncWork();

      const currentFlow = getTaskFlowById(flow.flowId);
      expect(currentFlow?.status).toBe("running");
      expect(currentFlow?.blockedTaskId).toBeUndefined();
    });
  });

  it("rejects parent flow links once cancellation has been requested", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForTests();

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-registry",
        goal: "Cancelling flow",
        cancelRequestedAt: 42,
      });

      try {
        createTaskFixture("acp", {
          status: undefined,
          deliveryStatus: undefined,
          parentFlowId: flow.flowId,
          runId: "cancel-requested-link",
          task: "Should be denied",
        });
        throw new Error("Expected createTaskFixture to throw.");
      } catch (error) {
        expect(isParentFlowLinkError(error)).toBe(true);
        expectRecordFields(error, {
          code: "cancel_requested",
          message: "Parent flow cancellation has already been requested.",
        });
      }
    });
  });

  it("keeps managed cancellation pending while a child kill is provisional", async () => {
    await withTaskRegistryTempDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-registry",
        goal: "Wait for canonical child state",
      });
      const task = createTaskFixture("subagent", {
        ownerKey: flow.ownerKey,
        parentFlowId: flow.flowId,
        childSessionKey: "agent:worker:subagent:provisional-flow",
        runId: "run-provisional-managed-flow",
        task: "Resolve cancellation race",
      });
      expect(
        requestFlowCancel({
          flowId: flow.flowId,
          expectedRevision: getTaskFlowById(flow.flowId)!.revision,
          cancelRequestedAt: 100,
        }).applied,
      ).toBe(true);

      finalizeSubagentTask(task, {
        status: "cancelled",
        endedAt: 200,
        error: SUBAGENT_KILL_TASK_ERROR,
      });

      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "queued",
        cancelRequestedAt: 100,
      });
    });
  });

  it("rejects parent flow links for terminal flows", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForTests();

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-registry",
        goal: "Completed flow",
        status: "cancelled",
      });

      expect(() =>
        createTaskFixture("acp", {
          status: undefined,
          deliveryStatus: undefined,
          parentFlowId: flow.flowId,
          runId: "terminal-flow-link",
          task: "Should be denied",
        }),
      ).toThrow("Parent flow is already cancelled.");
    });
  });

  it("queues delegated ACP completion to the requester session when a delivery origin exists", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      createAcpTaskRecord({
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
          threadId: "321",
        },
        runId: "run-delivery",
        task: "Investigate issue",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-delivery",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      await waitForAssertion(() =>
        expectRecordFields(requireTaskByRunId("run-delivery"), {
          status: "succeeded",
          deliveryStatus: "pending",
        }),
      );
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
      expect(peekSystemEvents("agent:main:main")).toEqual([
        expect.stringContaining("Background task ready for review: ACP background task"),
      ]);
    });
  });

  it("keeps direct delegated ACP completions pending so parent-review handoffs can retry", async () => {
    await withTaskRegistryTempDir(
      async () => {
        hoisted.sendMessageMock.mockResolvedValue({
          channel: "notifychat",
          to: "notifychat:123",
          via: "direct",
        });

        const task = createAcpTaskRecord({
          requesterOrigin: NOTIFYCHAT_ORIGIN,
          runId: "run-delivery-retry",
          task: "Investigate issue",
          status: "succeeded",
        });

        await waitForAssertion(() =>
          expect(peekSystemEvents("agent:main:main")).toEqual([
            expect.stringContaining("Background task ready for review: ACP background task"),
          ]),
        );
        expectRecordFields(requireTaskById(task.taskId), {
          deliveryStatus: "pending",
        });

        resetSystemEventsForTest();
        reloadTaskRegistryFromStore();
        await maybeDeliverTaskTerminalUpdate(task.taskId);

        expectRecordFields(requireTaskById(task.taskId), {
          deliveryStatus: "pending",
        });
        expect(peekSystemEvents("agent:main:main")).toEqual([
          expect.stringContaining("Background task ready for review: ACP background task"),
        ]);
        expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
      },
      { durableStore: true },
    );
  });

  it("delivers non-delegated ACP completion to the requester channel when a delivery origin exists", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      createTaskFixture("acp", {
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
          threadId: "321",
        },
        runId: "run-direct-delivery",
        task: "Investigate issue",
        deliveryStatus: "pending",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-direct-delivery",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      await waitForAssertion(() =>
        expectRecordFields(requireTaskByRunId("run-direct-delivery"), {
          status: "succeeded",
          deliveryStatus: "delivered",
        }),
      );
      await waitForAssertion(() => expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1));
      const message = sentMessageCall();
      expectRecordFields(message, {
        channel: "notifychat",
        to: "notifychat:123",
        threadId: "321",
      });
      expect(String(message.content)).toContain("Background task done: ACP background task");
      expectRecordFields(message.mirror, {
        sessionKey: "agent:main:main",
      });
      expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
    });
  });

  it("delivers delegated ACP completion directly to an explicitly bound Discord thread", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const runId = "run-bound-discord-thread-terminal";
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "channel:parent-channel",
        via: "direct",
      });

      createAcpTaskRecord({
        ownerKey: "agent:main:discord:guild-123:channel-parent-channel",
        requesterOrigin: {
          channel: "discord",
          to: "channel:parent-channel",
          threadId: "thread-84022",
        },
        runId,
        task: "Investigate thread-bound ACP delivery",
        terminalSummary: "ACP final answer",
        startedAt: 100,
      });

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      await waitForAssertion(() => {
        const task = findTaskByRunId(runId);
        if (!task) {
          throw new Error(`Expected task for run ${runId}`);
        }
        expect(task.status).toBe("succeeded");
        expect(task.deliveryStatus).toBe("delivered");
      });
      await waitForAssertion(() => expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1));
      const message = sentMessageCall();
      expectRecordFields(message, {
        channel: "discord",
        to: "channel:parent-channel",
        threadId: "thread-84022",
      });
      expect(String(message.content)).toContain(
        "Background task ready for review: ACP background task",
      );
      expect(String(message.content)).toContain("ACP final answer");
      expect(String(message.content)).toContain(
        "Next: parent will review/verify before calling it done.",
      );
      expect(peekSystemEvents("agent:main:discord:guild-123:channel-parent-channel")).toStrictEqual(
        [],
      );
    });
  });

  it.each([
    {
      id: "missing-thread",
      requesterOrigin: {
        channel: "discord",
        to: "channel:parent-channel",
      },
    },
    {
      id: "non-channel-target",
      requesterOrigin: {
        channel: "discord",
        to: "user:U123",
        threadId: "thread-84022",
      },
    },
    {
      id: "non-discord-channel",
      requesterOrigin: {
        channel: "guildchat",
        to: "guildchat:channel:parent-channel",
        threadId: "thread-84022",
      },
    },
  ])(
    "keeps delegated ACP completion queued without an explicit bound Discord thread ($id)",
    async ({ requesterOrigin }) => {
      await withTaskRegistryTempDir(async (root) => {
        process.env.OPENCLAW_STATE_DIR = root;
        resetTaskRegistryForTests();
        const runId = `run-non-bound-discord-thread-terminal-${requesterOrigin.channel}-${requesterOrigin.to}`;
        hoisted.sendMessageMock.mockResolvedValue({
          channel: requesterOrigin.channel,
          to: requesterOrigin.to,
          via: "direct",
        });

        createAcpTaskRecord({
          ownerKey: "agent:main:discord:guild-123:channel-parent-channel",
          requesterOrigin,
          runId,
          task: "Investigate thread-bound ACP delivery",
          terminalSummary: "ACP final answer",
          startedAt: 100,
        });

        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            endedAt: 250,
          },
        });

        await waitForAssertion(() => {
          const task = findTaskByRunId(runId);
          if (!task) {
            throw new Error(`Expected task for run ${runId}`);
          }
          expect(task.status).toBe("succeeded");
          expect(task.deliveryStatus).toBe("session_queued");
        });
        expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
        expect(peekSystemEvents("agent:main:discord:guild-123:channel-parent-channel")).toEqual([
          expect.stringContaining("Background task ready for review: ACP background task"),
        ]);
      });
    },
  );

  it.each([
    {
      id: "channel",
      name: "room channel",
      ownerKey: "agent:main:guildchat:channel:123",
      target: "guildchat:channel:123",
    },
    {
      id: "group",
      name: "group",
      ownerKey: "agent:main:guildchat:group:123",
      target: "guildchat:group:123",
    },
    {
      id: "topic",
      name: "group topic",
      ownerKey: "agent:main:guildchat:group:-100123:topic:42",
      target: "guildchat:group:-100123:topic:42",
    },
    {
      id: "discord-legacy-channel",
      name: "legacy Discord channel",
      ownerKey: "agent:main:discord:guild-123:channel-456",
      target: "guildchat:channel:456",
    },
    {
      id: "whatsapp-legacy-group",
      name: "legacy WhatsApp group",
      ownerKey: "agent:main:whatsapp:123@g.us",
      target: "guildchat:group:123@g.us",
    },
  ])("routes $name ACP completion through the parent session", async ({ id, ownerKey, target }) => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryForTests();
      const runId = `run-group-terminal-${id}`;
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "guildchat",
        to: target,
        via: "direct",
      });

      createAcpTaskRecord({
        ownerKey,
        requesterOrigin: {
          channel: "guildchat",
          to: target,
        },
        runId,
        task: "Investigate issue",
        startedAt: 100,
      });

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      await waitForAssertion(() => {
        const task = findTaskByRunId(runId);
        if (!task) {
          throw new Error(`Expected task for run ${runId}`);
        }
        expect(task.status).toBe("succeeded");
        expect(task.deliveryStatus).toBe("session_queued");
      });
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
      expect(peekSystemEvents(ownerKey)).toEqual([
        expect.stringContaining("Background task ready for review: ACP background task"),
      ]);
      await flushHeartbeatWakeRequests();
      expectHeartbeatWake("background-task", ownerKey);
    });
  });

  it("records delivery failure and queues a session fallback when direct delivery misses", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockRejectedValueOnce(new Error("notifychat unavailable"));

      createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-delivery-fail",
        task: "Investigate issue",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-delivery-fail",
        stream: "lifecycle",
        data: {
          phase: "error",
          endedAt: 250,
          error: "Permission denied by ACP runtime",
        },
      });

      await waitForAssertion(() =>
        expectRecordFields(requireTaskByRunId("run-delivery-fail"), {
          status: "failed",
          deliveryStatus: "failed",
          error: "Permission denied by ACP runtime",
        }),
      );
      await waitForAssertion(() => {
        const events = peekSystemEvents("agent:main:main");
        expect(events).toHaveLength(1);
        expect(events[0]).toContain("Background task failed: ACP background task");
      });
    });
  });

  it("still wakes the parent when blocked delivery misses the outward channel", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockRejectedValueOnce(new Error("notifychat unavailable"));

      createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-delivery-blocked",
        task: "Port the repo changes",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expectRecordFields(requireTaskByRunId("run-delivery-blocked"), {
          status: "succeeded",
          deliveryStatus: "failed",
          terminalOutcome: "blocked",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Background task blocked: ACP background task (run run-deli). Writable session or apply_patch authorization required.",
        "Task needs follow-up: ACP background task (run run-deli). Writable session or apply_patch authorization required.",
      ]);
      await flushHeartbeatWakeRequests();
      expectHeartbeatWake("background-task-blocked", "agent:main:main");
    });
  });

  it("marks internal fallback delivery as session queued instead of delivered", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createAcpTaskRecord({
        runId: "run-session-queued",
        task: "Investigate issue",
        startedAt: 100,
      });

      emitAgentEvent({
        runId: "run-session-queued",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      await waitForAssertion(() =>
        expectRecordFields(requireTaskByRunId("run-session-queued"), {
          status: "succeeded",
          deliveryStatus: "session_queued",
        }),
      );
      const events = peekSystemEvents("agent:main:main");
      expect(events).toHaveLength(1);
      expect(events[0]).toContain("Background task ready for review: ACP background task");
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  it("wakes the parent for blocked tasks even when delivery falls back to the session", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createAcpTaskRecord({
        runId: "run-session-blocked",
        task: "Port the repo changes",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expectRecordFields(requireTaskByRunId("run-session-blocked"), {
          status: "succeeded",
          deliveryStatus: "session_queued",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Background task blocked: ACP background task (run run-sess). Writable session or apply_patch authorization required.",
        "Task needs follow-up: ACP background task (run run-sess). Writable session or apply_patch authorization required.",
      ]);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
      await flushHeartbeatWakeRequests();
      expectHeartbeatWake("background-task-blocked", "agent:main:main");
    });
  });

  it("does not include internal progress detail in the terminal channel message", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      createAcpTaskRecord({
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
          threadId: "321",
        },
        runId: "run-detail-leak",
        task: "Create the file and verify it",
        startedAt: 100,
      });

      recordTaskProgressByRunId({
        runId: "run-detail-leak",
        progressSummary:
          "I am loading the local session context and checking helper command availability before writing the file.",
      });

      emitAgentEvent({
        runId: "run-detail-leak",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      await waitForAssertion(() => {
        const events = peekSystemEvents("agent:main:main");
        expect(events).toHaveLength(1);
        expect(events[0]).toBe(
          "Background task ready for review: ACP background task (run run-deta). Next: parent will review/verify before calling it done.",
        );
      });
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  it("surfaces blocked outcomes separately from completed tasks", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-blocked-outcome",
        task: "Port the repo changes",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expectRecordFields(sentMessageCall(), {
          content:
            "Background task blocked: ACP background task (run run-bloc). Writable session or apply_patch authorization required.",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Task needs follow-up: ACP background task (run run-bloc). Writable session or apply_patch authorization required.",
      ]);
      await flushHeartbeatWakeRequests();
      expectHeartbeatWake("background-task-blocked", "agent:main:main");
    });
  });

  it("does not queue an unblock follow-up for ordinary completed tasks", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-succeeded-outcome",
        task: "Create the file and verify it",
        status: "succeeded",
        terminalSummary: "Created /tmp/file.txt and verified contents.",
        terminalOutcome: "succeeded",
      });

      await waitForAssertion(() => {
        const events = peekSystemEvents("agent:main:main");
        expect(events).toHaveLength(1);
        expect(events[0]).toBe(
          "Background task ready for review: ACP background task (run run-succ). Created /tmp/file.txt and verified contents. Next: parent will review/verify before calling it done.",
        );
      });
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
      await flushHeartbeatWakeRequests();
      expectHeartbeatWake("background-task", "agent:main:main");
      expect(heartbeatWakeRequests).not.toContainEqual(
        expect.objectContaining({ source: "background-task-blocked" }),
      );
    });
  });

  it("keeps distinct task records when different producers share a runId", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createTaskFixture("cli", {
        ownerKey: "agent:codex:acp:child",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-shared",
        task: "Child ACP execution",
      });

      createTaskFixture("acp", {
        childSessionKey: "agent:codex:acp:child",
        runId: "run-shared",
        task: "Spawn ACP child",
        deliveryStatus: "pending",
      });

      expect(countMatching(listTaskRecords(), (task) => task.runId === "run-shared")).toBe(2);
      expectRecordFields(requireTaskByRunId("run-shared"), {
        runtime: "acp",
        task: "Spawn ACP child",
      });
    });
  });

  it("scopes shared-run lifecycle events to the matching session", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      const victimTask = createTaskFixture("acp", {
        ownerKey: "agent:victim:main",
        childSessionKey: "agent:victim:acp:child",
        runId: "run-shared-scope",
        task: "Victim ACP task",
        deliveryStatus: "pending",
      });

      const attackerTask = createTaskFixture("cli", {
        ownerKey: "agent:attacker:main",
        childSessionKey: "agent:attacker:main",
        runId: "run-shared-scope",
        task: "Attacker CLI task",
      });

      registerAgentRunContext("run-shared-scope", {
        sessionKey: "agent:attacker:main",
      });
      emitAgentEvent({
        runId: "run-shared-scope",
        stream: "lifecycle",
        data: {
          phase: "error",
          endedAt: 250,
          error: "attacker controlled error",
        },
      });

      expectRecordFields(requireTaskById(attackerTask.taskId), {
        status: "failed",
        error: "attacker controlled error",
      });
      expectRecordFields(requireTaskById(victimTask.taskId), {
        status: "running",
      });
      expect(getTaskById(victimTask.taskId)).not.toHaveProperty("error");
    });
  });

  it("suppresses duplicate ACP delivery when a preferred spawned task shares the runId", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      const directTask = createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-shared-delivery",
        task: "Direct ACP child",
        status: "succeeded",
      });
      const spawnedTask = createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-shared-delivery",
        task: "Spawn ACP child",
        preferMetadata: true,
        status: "succeeded",
      });

      await maybeDeliverTaskTerminalUpdate(directTask.taskId);
      await maybeDeliverTaskTerminalUpdate(spawnedTask.taskId);

      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
      expect(countMatching(listTaskRecords(), (task) => task.runId === "run-shared-delivery")).toBe(
        1,
      );
      expectRecordFields(requireTaskByRunId("run-shared-delivery"), {
        taskId: directTask.taskId,
        task: "Spawn ACP child",
        deliveryStatus: "pending",
      });
      expect(peekSystemEvents("agent:main:main")).toEqual([
        expect.stringContaining("Background task ready for review: ACP background task"),
      ]);
    });
  });

  it("does not suppress ACP delivery across different requester scopes when runIds collide", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      const victimTask = createTaskFixture("acp", {
        ownerKey: "agent:victim:main",
        childSessionKey: "agent:victim:acp:child",
        runId: "run-cross-requester-delivery",
        task: "Victim ACP task",
        deliveryStatus: "pending",
      });
      const attackerTask = createTaskFixture("acp", {
        ownerKey: "agent:attacker:main",
        childSessionKey: "agent:attacker:acp:child",
        runId: "run-cross-requester-delivery",
        task: "Attacker ACP task",
        deliveryStatus: "pending",
      });

      markTaskTerminalById({
        taskId: victimTask.taskId,
        status: "succeeded",
        endedAt: 250,
      });
      markTaskTerminalById({
        taskId: attackerTask.taskId,
        status: "succeeded",
        endedAt: 260,
      });
      await maybeDeliverTaskTerminalUpdate(victimTask.taskId);
      await maybeDeliverTaskTerminalUpdate(attackerTask.taskId);

      await waitForAssertion(() =>
        expectRecordFields(requireTaskById(victimTask.taskId), {
          deliveryStatus: "session_queued",
        }),
      );
      await waitForAssertion(() =>
        expectRecordFields(requireTaskById(attackerTask.taskId), {
          deliveryStatus: "session_queued",
        }),
      );
    });
  });

  it("adopts preferred ACP spawn metadata when collapsing onto an earlier direct record", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      const directTask = createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-collapse-preferred",
        task: "Direct ACP child",
      });

      const spawnedTask = createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-collapse-preferred",
        label: "Quant patch",
        task: "Implement the feature and report back",
        preferMetadata: true,
      });

      expect(spawnedTask.taskId).toBe(directTask.taskId);
      expectRecordFields(requireTaskByRunId("run-collapse-preferred"), {
        taskId: directTask.taskId,
        label: "Quant patch",
        task: "Implement the feature and report back",
      });
    });
  });

  it("collapses ACP run-owned task creation onto the existing spawned task", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      const spawnedTask = createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-collapse",
        task: "Spawn ACP child",
      });

      const directTask = createTaskFixture("acp", {
        deliveryStatus: undefined,
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse",
        task: "Direct ACP child",
      });

      expect(directTask.taskId).toBe(spawnedTask.taskId);
      expect(countMatching(listTaskRecords(), (task) => task.runId === "run-collapse")).toBe(1);
      expectRecordFields(requireTaskByRunId("run-collapse"), {
        task: "Spawn ACP child",
      });
    });
  });

  it("delivers a terminal ACP update only once when multiple notifiers race", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      const task = createAcpTaskRecord({
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        runId: "run-racing-delivery",
        task: "Investigate issue",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      const first = maybeDeliverTaskTerminalUpdate(task.taskId);
      const second = maybeDeliverTaskTerminalUpdate(task.taskId);
      await Promise.all([first, second]);

      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
      const message = sentMessageCall();
      expectRecordFields(message, {
        idempotencyKey: `task-terminal:${task.taskId}:succeeded:blocked`,
      });
      expectRecordFields(message.mirror, {
        idempotencyKey: `task-terminal:${task.taskId}:succeeded:blocked`,
      });
      expectRecordFields(requireTaskByRunId("run-racing-delivery"), {
        deliveryStatus: "delivered",
      });
    });
  });

  it("keeps detached terminal delivery root-admitted through mirror persistence", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      let releaseSend = () => {};
      hoisted.sendMessageMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSend = () =>
              resolve({ channel: "notifychat", to: "notifychat:123", via: "direct" });
          }),
      );
      createAcpTaskRecord({
        requesterOrigin: { channel: "notifychat", to: "notifychat:123" },
        runId: "run-held-delivery",
        task: "Deliver after completion",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Waiting for parent review.",
      });

      await waitForFast(() => expect(hoisted.sendMessageMock).toHaveBeenCalledOnce());
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      releaseSend();
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expectRecordFields(requireTaskByRunId("run-held-delivery"), {
        deliveryStatus: "delivered",
      });
    });
  });

  it("restores persisted tasks from disk on the next lookup", async () => {
    await withTaskRegistryTempDir(
      async () => {
        resetTaskRegistryForTests();

        const task = createTaskFixture("subagent", {
          childSessionKey: "agent:main:subagent:child",
          runId: "run-restore",
          task: "Restore me",
          deliveryStatus: "pending",
        });

        resetTaskRegistryForTests({
          persist: false,
        });

        expectRecordFields(resolveTaskForLookupToken(task.taskId), {
          taskId: task.taskId,
          runId: "run-restore",
          task: "Restore me",
        });
      },
      { durableStore: true },
    );
  });

  it("indexes tasks by session key for latest and list lookups", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(1_700_000_000_000);

      const older = createTaskFixture("acp", {
        status: undefined,
        deliveryStatus: undefined,
        childSessionKey: "agent:main:subagent:child-1",
        runId: "run-session-lookup-1",
        task: "Older task",
      });
      const latest = createTaskFixture("subagent", {
        status: undefined,
        deliveryStatus: undefined,
        childSessionKey: "agent:main:subagent:child-2",
        runId: "run-session-lookup-2",
        task: "Latest task",
      });
      nowSpy.mockRestore();

      expect(listTasksForOwnerKey("agent:main:main")[0]?.taskId).toBe(latest.taskId);
      expect(listTasksForOwnerKey("agent:main:main").map((task) => task.taskId)).toEqual([
        latest.taskId,
        older.taskId,
      ]);
      expect(listTasksForRelatedSessionKey("agent:main:subagent:child-1")[0]?.taskId).toBe(
        older.taskId,
      );
    });
  });

  it("infers agent ids for session-scoped tasks", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });

      const created = createTaskFixture("cli", {
        ownerKey: undefined,
        scopeKind: undefined,
        taskKind: "video_generation",
        sourceId: "video_generate:openai",
        requesterSessionKey: "agent:main:discord:direct:123",
        childSessionKey: "agent:main:discord:direct:123",
        runId: "tool:video_generate:agent-index",
        task: "Generate a lobster video",
        notifyPolicy: "silent",
      });

      expect(created.agentId).toBe("main");
      expect(listTasksForAgentId("main").map((task) => task.taskId)).toEqual([created.taskId]);
    });
  });

  it("uses the child session agent for cross-agent background task attribution", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest({ persist: false });

      const created = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:child",
        runId: "run-worker-subagent",
        task: "Inspect worker state",
        deliveryStatus: "pending",
      });

      expect(created.agentId).toBe("worker");
      expect(listTasksForAgentId("worker").map((task) => task.taskId)).toEqual([created.taskId]);
      expect(listTasksForAgentId("main")).toEqual([]);
    });
  });

  it("retains live background exec tasks and marks missing process sessions lost", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const task = createTaskFixture("cli", {
        taskKind: "exec",
        sourceId: "amber-reef",
        runId: "exec:amber-reef",
        task: "Background CLI command",
        lastEventAt: Date.now() - 10 * 60_000,
      });
      const currentTasks = new Map([[task.taskId, task]]);
      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks,
        snapshotTasks: [task],
        isBackgroundExecSessionActive: () => true,
      });

      expect(await runTaskRegistryMaintenance()).toEqual({
        reconciled: 0,
        recovered: 0,
        cleanupStamped: 0,
        pruned: 0,
      });
      expectRecordFields(currentTasks.get(task.taskId), { status: "running" });

      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks,
        snapshotTasks: [task],
        isBackgroundExecSessionActive: () => false,
      });
      expect(await runTaskRegistryMaintenance()).toEqual({
        reconciled: 1,
        recovered: 0,
        cleanupStamped: 0,
        pruned: 0,
      });
      expectRecordFields(currentTasks.get(task.taskId), {
        status: "lost",
        error: "backing session missing",
      });
    });
  });

  it("projects inspection-time orphaned tasks as lost without mutating the registry", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });

      const task = createTaskFixture("acp", {
        childSessionKey: "agent:main:acp:missing",
        runId: "run-lost",
        task: "Missing child",
        deliveryStatus: "pending",
        lastEventAt: Date.now() - 10 * 60_000,
      });

      const tasks = reconcileInspectableTasks();
      expectRecordFields(tasks[0], {
        runId: "run-lost",
        status: "lost",
        error: "backing session missing",
      });
      expectRecordFields(requireTaskById(task.taskId), {
        status: "running",
      });
      expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
    });
  });

  it("keeps zero-argument inspection helpers fresh", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-16T00:00:00Z"));

      const task = createTaskFixture("subagent", {
        runId: "run-inspection-freshness",
        task: "Inspect fresh task state",
        deliveryStatus: "pending",
      });
      let listCalls = 0;
      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map([[task.taskId, task]]),
        snapshotTasks: [task],
        listTaskRecords: () => {
          listCalls += 1;
          return listCalls === 1 ? [task] : [];
        },
      });

      expect(getInspectableTaskRegistrySummary().total).toBe(1);
      expect(getInspectableTaskAuditFindings()).toStrictEqual([]);
      expect(listCalls).toBe(2);
    });
  });

  it("marks orphaned tasks lost with cleanupAfter in a single maintenance pass", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
      const now = Date.now();

      const task = createTaskFixture("acp", {
        childSessionKey: "agent:main:acp:missing",
        runId: "run-lost-maintenance",
        task: "Missing child",
        deliveryStatus: "pending",
        lastEventAt: now - 10 * 60_000,
      });

      expect(await runTaskRegistryMaintenance()).toEqual({
        reconciled: 1,
        recovered: 0,
        cleanupStamped: 0,
        pruned: 0,
      });
      expectRecordFields(requireTaskById(task.taskId), {
        status: "lost",
        error: "backing session missing",
      });
      const lostTask = getTaskById(task.taskId);
      expect(lostTask?.cleanupAfter).toBeGreaterThan(now);
      expect((lostTask?.cleanupAfter ?? 0) - (lostTask?.endedAt ?? 0)).toBe(LOST_TASK_RETENTION_MS);
      const summary = getInspectableTaskAuditSummary();
      expectRecordFields(summary, {
        errors: 0,
        warnings: 1,
      });
      expect(summary.byCode.lost).toBe(1);
    });
  });

  it.each([
    {
      name: "keeps fresh childless codex-native subagent tasks live",
      taskKind: "codex-native",
      sourceId: "codex-thread:child-thread",
      task: "Codex native child",
      ageMinutes: 10,
      reconciled: 0,
      error: undefined,
    },
    {
      name: "marks stale childless codex-native subagent tasks lost",
      taskKind: "codex-native",
      sourceId: "codex-thread:child-thread",
      task: "Codex native child",
      ageMinutes: 31,
      reconciled: 1,
      error: "Codex native subagent stopped reporting progress",
    },
    {
      name: "keeps fresh childless copilot-native subagent tasks live",
      taskKind: "copilot-native",
      sourceId: "copilot-agent:child-agent",
      task: "Copilot native child",
      ageMinutes: 10,
      reconciled: 0,
      error: undefined,
    },
    {
      name: "marks stale childless copilot-native subagent tasks lost",
      taskKind: "copilot-native",
      sourceId: "copilot-agent:child-agent",
      task: "Copilot native child",
      ageMinutes: 31,
      reconciled: 1,
      error: "Native subagent stopped reporting progress",
    },
    {
      name: "does not mark unrelated childless subagent tasks lost",
      taskKind: "codex-native",
      sourceId: "other-runtime:child-thread",
      task: "Non-Codex childless row",
      ageMinutes: 31,
      reconciled: 0,
      error: undefined,
    },
  ])("$name", async ({ taskKind, sourceId, task: taskName, ageMinutes, reconciled, error }) => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryForTests();
      const now = Date.now();
      const lastEventAt = now - ageMinutes * 60_000;
      const task = createTaskFixture("subagent", {
        taskKind,
        sourceId,
        runId: sourceId,
        task: taskName,
        notifyPolicy: "silent",
        lastEventAt,
      });

      expect(await runTaskRegistryMaintenance()).toEqual({
        reconciled,
        recovered: 0,
        cleanupStamped: 0,
        pruned: 0,
      });
      expectRecordFields(
        requireTaskById(task.taskId),
        error === undefined ? { status: "running", lastEventAt } : { status: "lost", error },
      );
    });
  });

  it.each([
    {
      name: "closes terminal parent-owned one-shot ACP sessions during maintenance",
      mode: "oneshot" as const,
      childSessionKey: "agent:claude:acp:stale-oneshot",
      runId: "run-terminal-acp-oneshot",
      task: "Old ACP task",
      status: "succeeded" as const,
      deliveryStatus: "delivered" as const,
      bound: false,
      closes: true,
      checksSummary: true,
    },
    {
      name: "closes stale terminal persistent ACP sessions only when no binding remains",
      mode: "persistent" as const,
      childSessionKey: "agent:claude:acp:stale-persistent",
      runId: "run-terminal-acp-persistent",
      task: "Old persistent ACP task",
      status: "failed" as const,
      deliveryStatus: "failed" as const,
      bound: false,
      closes: true,
      checksSummary: false,
    },
    {
      name: "keeps terminal persistent ACP sessions that still have an active binding",
      mode: "persistent" as const,
      childSessionKey: "agent:claude:acp:bound-persistent",
      runId: "run-terminal-acp-bound",
      task: "Thread-bound ACP session",
      status: "succeeded" as const,
      deliveryStatus: "delivered" as const,
      bound: true,
      closes: false,
      checksSummary: false,
    },
  ])(
    "$name",
    async ({
      mode,
      childSessionKey,
      runId,
      task: taskName,
      status,
      deliveryStatus,
      bound,
      closes,
      checksSummary,
    }) => {
      await withTaskRegistryTempDir(async () => {
        resetTaskRegistryMemoryForTest();
        const now = Date.now();
        const parentSessionKey = "agent:main:telegram:direct:owner";
        const task = createTaskFixture("acp", {
          ownerKey: parentSessionKey,
          requesterSessionKey: parentSessionKey,
          childSessionKey,
          runId,
          task: taskName,
          status,
          deliveryStatus,
          lastEventAt: now - 60_000,
        });
        finalizeTaskRunByRunId({
          runId,
          runtime: "acp",
          status,
          endedAt: now - 60_000,
          lastEventAt: now - 60_000,
        });
        const current = getTaskById(task.taskId)!;
        const closeAcpSession = vi.fn().mockResolvedValue(undefined);
        const unbindSessionBindings = vi.fn().mockResolvedValue([]);

        configureTaskRegistryMaintenanceRuntimeForTest({
          currentTasks: new Map([[task.taskId, current]]),
          snapshotTasks: [current],
          acpEntry: createAcpSessionStoreEntry({
            sessionKey: childSessionKey,
            parentSessionKey,
            mode,
          }),
          sessionBindings: bound
            ? [createSessionBindingRecord({ targetSessionKey: childSessionKey })]
            : [],
          closeAcpSession,
          unbindSessionBindings,
        });

        const result = await runTaskRegistryMaintenance();
        if (checksSummary) {
          expectRecordFields(result, { reconciled: 0, recovered: 0, pruned: 0 });
        }
        if (!closes) {
          expect(closeAcpSession).not.toHaveBeenCalled();
          expect(unbindSessionBindings).not.toHaveBeenCalled();
          return;
        }
        expect(closeAcpSession).toHaveBeenCalledWith({
          cfg: {},
          sessionKey: childSessionKey,
          reason: "terminal-task-cleanup",
        });
        expect(unbindSessionBindings).toHaveBeenCalledWith({
          targetSessionKey: childSessionKey,
          reason: "terminal-task-cleanup",
        });
      });
    },
  );

  it("does not relist task records for each terminal ACP cleanup check", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const now = Date.now();
      const tasks = Array.from({ length: 20 }, (_, index) => {
        const task = createTaskFixture("acp", {
          requesterSessionKey: "agent:main:main",
          childSessionKey: `agent:claude:acp:terminal-${index}`,
          runId: `run-terminal-acp-snapshot-${index}`,
          task: `Terminal ACP task ${index}`,
          status: "succeeded",
          deliveryStatus: "delivered",
        });
        return {
          ...task,
          endedAt: now - 60_000,
          lastEventAt: now - 60_000,
        };
      });
      const currentTasks = new Map(tasks.map((task) => [task.taskId, task]));
      let listCalls = 0;

      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks,
        snapshotTasks: tasks,
        listTaskRecords: () => {
          listCalls += 1;
          return tasks;
        },
      });

      await runTaskRegistryMaintenance();

      expect(listCalls).toBe(1);
    });
  });

  it("keeps terminal ACP cleanup from closing a child session with fresh active work", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const now = Date.now();
      const parentSessionKey = "agent:main:telegram:direct:owner";
      const childSessionKey = "agent:claude:acp:shared-child";
      const terminal = createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey,
        runId: "run-terminal-acp-shared",
        task: "Old ACP task",
        status: "succeeded",
        deliveryStatus: "delivered",
      });
      const terminalCurrent = {
        ...terminal,
        endedAt: now - 60_000,
        lastEventAt: now - 60_000,
      };
      const active = createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey,
        runId: "run-active-acp-shared",
        task: "Current ACP task",
        deliveryStatus: "pending",
      });
      const closeAcpSession = vi.fn().mockResolvedValue(undefined);

      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map([
          [terminal.taskId, terminalCurrent],
          [active.taskId, active],
        ]),
        snapshotTasks: [terminalCurrent],
        acpEntry: createAcpSessionStoreEntry({
          sessionKey: childSessionKey,
          parentSessionKey,
          mode: "oneshot",
        }),
        closeAcpSession,
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "closes orphaned parent-owned one-shot ACP sessions after task records are gone",
      mode: "oneshot" as const,
      childSessionKey: "agent:claude:acp:orphaned-oneshot",
      bound: false,
      closes: true,
    },
    {
      name: "keeps orphaned parent-owned persistent ACP sessions while a binding is active",
      mode: "persistent" as const,
      childSessionKey: "agent:claude:acp:bound-orphaned-persistent",
      bound: true,
      closes: false,
    },
    {
      name: "closes orphaned parent-owned persistent ACP sessions without active bindings",
      mode: "persistent" as const,
      childSessionKey: "agent:claude:acp:unbound-orphaned-persistent",
      bound: false,
      closes: true,
    },
  ])("$name", async ({ mode, childSessionKey, bound, closes }) => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const parentSessionKey = "agent:main:telegram:direct:owner";
      const closeAcpSession = vi.fn().mockResolvedValue(undefined);
      const unbindSessionBindings = vi.fn().mockResolvedValue([]);

      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map(),
        snapshotTasks: [],
        acpEntries: [
          createAcpSessionStoreEntry({ sessionKey: childSessionKey, parentSessionKey, mode }),
        ],
        sessionBindings: bound
          ? [createSessionBindingRecord({ targetSessionKey: childSessionKey })]
          : [],
        closeAcpSession,
        unbindSessionBindings,
      });

      await runTaskRegistryMaintenance();
      if (!closes) {
        expect(closeAcpSession).not.toHaveBeenCalled();
        expect(unbindSessionBindings).not.toHaveBeenCalled();
        return;
      }
      expect(closeAcpSession).toHaveBeenCalledWith({
        cfg: {},
        sessionKey: childSessionKey,
        reason: "orphaned-parent-task-cleanup",
      });
      expect(unbindSessionBindings).toHaveBeenCalledWith({
        targetSessionKey: childSessionKey,
        reason: "orphaned-parent-task-cleanup",
      });
    });
  });

  it("prunes old terminal tasks during maintenance sweeps", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();

      createTaskFixture("cli", {
        childSessionKey: "agent:main:main",
        runId: "run-prune",
        task: "Old completed task",
        status: "succeeded",
        startedAt: Date.now() - 9 * 24 * 60 * 60_000,
        lastEventAt: Date.now() - 8 * 24 * 60 * 60_000,
      });
      finalizeTaskRunByRunId({
        runId: "run-prune",
        runtime: "cli",
        status: "succeeded",
        endedAt: Date.now() - 8 * 24 * 60 * 60_000,
        lastEventAt: Date.now() - 8 * 24 * 60 * 60_000,
      });

      expect(await sweepTaskRegistry()).toEqual({
        reconciled: 0,
        recovered: 0,
        cleanupStamped: 0,
        pruned: 1,
      });
      expect(listTaskRecords()).toStrictEqual([]);
    });
  });

  it("previews and repairs missing cleanup timestamps during maintenance", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const now = Date.now();
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            tasks: new Map([
              [
                "task-missing-cleanup",
                {
                  taskId: "task-missing-cleanup",
                  runtime: "cli",
                  requesterSessionKey: "",
                  ownerKey: "system:cli:task-missing-cleanup",
                  scopeKind: "system",
                  runId: "run-maintenance-cleanup",
                  task: "Finished CLI task",
                  status: "failed",
                  deliveryStatus: "not_applicable",
                  notifyPolicy: "silent",
                  createdAt: now - 120_000,
                  endedAt: now - 60_000,
                  lastEventAt: now - 60_000,
                },
              ],
            ]),
            deliveryStates: new Map(),
          }),
          saveSnapshot: () => {},
        },
      });

      expect(previewTaskRegistryMaintenance()).toEqual({
        reconciled: 0,
        recovered: 0,
        cleanupStamped: 1,
        pruned: 0,
      });

      expect(await runTaskRegistryMaintenance()).toEqual({
        reconciled: 0,
        recovered: 0,
        cleanupStamped: 1,
        pruned: 0,
      });
      expect(getTaskById("task-missing-cleanup")?.cleanupAfter).toBeGreaterThan(now);
    });
  });

  it("cancels the deferred maintenance sweep during test teardown", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      resetTaskRegistryMemoryForTest();
      const now = Date.now();

      const task = createTaskFixture("acp", {
        childSessionKey: "agent:main:acp:missing",
        runId: "run-deferred-maintenance-stop",
        task: "Missing child",
        deliveryStatus: "pending",
        lastEventAt: now - 10 * 60_000,
      });

      startTaskRegistryMaintenance();
      stopTaskRegistryMaintenance();

      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsyncWork();

      expectRecordFields(requireTaskById(task.taskId), {
        status: "running",
      });
    });
  });

  it("keeps scheduled maintenance root-admitted until session cleanup inspection settles", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      resetTaskRegistryMemoryForTest();
      let releaseInspection = (_entries: AcpSessionStoreEntry[]) => {};
      const inspection = new Promise<AcpSessionStoreEntry[]>((resolve) => {
        releaseInspection = resolve;
      });
      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map(),
        snapshotTasks: [],
        listAcpSessionEntries: async () => await inspection,
      });

      startTaskRegistryMaintenance();
      await vi.advanceTimersByTimeAsync(5_000);
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));

      releaseInspection([]);
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      stopTaskRegistryMaintenance();
    });
  });

  it("does not leak unhandled rejections when the scheduled maintenance sweep fails", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      resetTaskRegistryMemoryForTest();

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      setTaskRegistryMaintenanceRuntimeForTests({
        listAcpSessionEntries: async () => [],
        readAcpSessionEntry: () => ({
          cfg: {} as never,
          storePath: "",
          sessionKey: "",
          storeSessionKey: "",
          entry: undefined,
          storeReadFailed: false,
        }),
        listSessionEntries: () => [],
        resolveStorePath: () => "",
        parseAgentSessionKey: () => null,
        isCronJobActive: () => false,
        getAgentRunContext: () => undefined,
        hasActiveAcpTurn: () => false,
        hasActiveTaskForChildSessionKey: () => false,
        deleteTaskRecordById: () => false,
        ensureTaskRegistryReady: () => {},
        getTaskById: () => undefined,
        listTaskRecords: () => {
          throw new Error("maintenance boom");
        },
        markTaskLostById: () => null,
        markTaskTerminalById: () => null,
        maybeDeliverTaskTerminalUpdate: async () => null,
        resolveTaskForLookupToken: () => undefined,
        setTaskCleanupAfterById: () => null,
        isRuntimeAuthoritative: () => true,
        listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: () => [],
      });

      try {
        startTaskRegistryMaintenance();
        await vi.advanceTimersByTimeAsync(5_000);
        await flushAsyncWork();
        expect(unhandled).toStrictEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    });
  });

  it("rechecks current task state before marking a task lost", async () => {
    const now = Date.now();
    const snapshotTask = createTaskFixture("acp", {
      childSessionKey: "agent:main:acp:missing-stale",
      runId: "run-lost-stale",
      task: "Missing child",
      deliveryStatus: "pending",
    });
    const staleTask = {
      ...snapshotTask,
      lastEventAt: now - 10 * 60_000,
    };
    const currentTask = {
      ...snapshotTask,
      lastEventAt: now,
    };
    const currentTasks = new Map([[snapshotTask.taskId, currentTask]]);
    configureTaskRegistryMaintenanceRuntimeForTest({
      currentTasks,
      snapshotTasks: [staleTask],
    });

    expect(await runTaskRegistryMaintenance()).toEqual({
      reconciled: 0,
      recovered: 0,
      cleanupStamped: 0,
      pruned: 0,
    });
    expectRecordFields(currentTasks.get(snapshotTask.taskId), {
      status: "running",
      lastEventAt: now,
    });
  });

  it("rechecks current task state before pruning a task", async () => {
    const now = Date.now();
    const snapshotTask = createTaskFixture("cli", {
      childSessionKey: "agent:main:main",
      runId: "run-prune-stale",
      task: "Old completed task",
      status: "succeeded",
      startedAt: now - 9 * 24 * 60 * 60_000,
    });
    const staleTask = {
      ...snapshotTask,
      endedAt: now - 8 * 24 * 60 * 60_000,
      lastEventAt: now - 8 * 24 * 60 * 60_000,
      cleanupAfter: now - 1,
    };
    const currentTask = {
      ...staleTask,
      cleanupAfter: now + 60_000,
    };
    const currentTasks = new Map([[snapshotTask.taskId, currentTask]]);
    configureTaskRegistryMaintenanceRuntimeForTest({
      currentTasks,
      snapshotTasks: [staleTask],
    });

    expect(await sweepTaskRegistry()).toEqual({
      reconciled: 0,
      recovered: 0,
      cleanupStamped: 0,
      pruned: 0,
    });
    expectRecordFields(currentTasks.get(snapshotTask.taskId), {
      status: "succeeded",
      cleanupAfter: now + 60_000,
    });
  });

  it("prunes retained lost tasks once the shorter lost retention window expires", async () => {
    const now = Date.now();
    const endedAt = now - LOST_TASK_RETENTION_MS - 1;
    const snapshotTask = createTaskFixture("cli", {
      childSessionKey: "agent:main:main",
      runId: "run-old-lost-cleanup",
      task: "Old lost task",
      status: "lost",
      startedAt: endedAt - 1,
    });
    const staleTask = {
      ...snapshotTask,
      endedAt,
      lastEventAt: endedAt,
      cleanupAfter: endedAt + DEFAULT_TASK_RETENTION_MS,
    };
    const currentTasks = new Map([[snapshotTask.taskId, staleTask]]);
    configureTaskRegistryMaintenanceRuntimeForTest({
      currentTasks,
      snapshotTasks: [staleTask],
    });

    expect(await sweepTaskRegistry()).toEqual({
      reconciled: 0,
      recovered: 0,
      cleanupStamped: 0,
      pruned: 1,
    });
    expect(currentTasks.has(snapshotTask.taskId)).toBe(false);
  });

  it("backdates createdAt when a task is created with an earlier startedAt", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

      const task = createTaskFixture("acp", {
        runId: "run-backdated-create",
        task: "Backdated create",
        deliveryStatus: "pending",
        startedAt: 1_699_999_999_000,
      });

      nowSpy.mockRestore();

      expectRecordFields(task, {
        createdAt: 1_699_999_999_000,
        startedAt: 1_699_999_999_000,
        lastEventAt: 1_699_999_999_000,
      });
      expect(getInspectableTaskAuditSummary().byCode.inconsistent_timestamps).toBe(0);
    });
  });

  it("keeps timestamps monotonic when an update supplies an earlier startedAt", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

      const task = createTaskFixture("acp", {
        runId: "run-backdated-update",
        task: "Backdated update",
        status: "queued",
        deliveryStatus: "pending",
      });

      nowSpy.mockReturnValue(1_700_000_001_000);
      markTaskRunningByRunId({
        runId: "run-backdated-update",
        startedAt: 1_699_999_998_000,
        lastEventAt: 1_699_999_998_500,
      });
      nowSpy.mockRestore();

      expectRecordFields(requireTaskById(task.taskId), {
        createdAt: 1_699_999_998_000,
        startedAt: 1_699_999_998_000,
        lastEventAt: 1_699_999_998_500,
      });
      expect(getInspectableTaskAuditSummary().byCode.inconsistent_timestamps).toBe(0);
    });
  });

  it("normalizes restored task timestamps before exposing them", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            tasks: new Map([
              [
                "task-restored-bad-timestamps",
                {
                  taskId: "task-restored-bad-timestamps",
                  runtime: "acp",
                  requesterSessionKey: "agent:main:main",
                  ownerKey: "agent:main:main",
                  scopeKind: "session",
                  runId: "run-restored-bad-timestamps",
                  task: "Restored task with old start time",
                  status: "running",
                  deliveryStatus: "pending",
                  notifyPolicy: "done_only",
                  createdAt: 200,
                  startedAt: 100,
                  lastEventAt: 150,
                },
              ],
            ]),
            deliveryStates: new Map(),
          }),
          saveSnapshot: () => {},
        },
      });

      expectRecordFields(requireTaskByRunId("run-restored-bad-timestamps"), {
        createdAt: 100,
        startedAt: 100,
        lastEventAt: 150,
      });
    });
  });

  it("reloads from durable state instead of preserving stale in-memory tasks", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const now = Date.now();
      let durableTasks = new Map<string, ReturnType<typeof createTaskFixture>>();
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            tasks: durableTasks,
            deliveryStates: new Map(),
          }),
          saveSnapshot: () => {},
          upsertTask: () => {},
          upsertTaskWithDeliveryState: () => {},
        },
      });

      createTaskFixture("cli", {
        requesterSessionKey: "agent:main:main",
        runId: "run-stale-memory",
        task: "Stale in-memory task",
        deliveryStatus: "pending",
        notifyPolicy: "silent",
        startedAt: now - 60_000,
        lastEventAt: now - 60_000,
      });
      expect(summarizeTaskRecords(listTaskRecords()).active).toBe(1);

      durableTasks = new Map([
        [
          "task-durable",
          {
            taskId: "task-durable",
            runtime: "cli",
            requesterSessionKey: "agent:main:main",
            ownerKey: "agent:main:main",
            scopeKind: "session",
            runId: "run-durable",
            task: "Durable terminal task",
            status: "cancelled",
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
            createdAt: now - 30_000,
            startedAt: now - 30_000,
            endedAt: now - 10_000,
            lastEventAt: now - 10_000,
          },
        ],
      ]);

      reloadTaskRegistryFromStore();

      expect(findTaskByRunId("run-stale-memory")).toBeUndefined();
      expectRecordFields(requireTaskByRunId("run-durable"), {
        taskId: "task-durable",
        status: "cancelled",
      });
      expect(summarizeTaskRecords(listTaskRecords()).active).toBe(0);
    });
  });

  it("reattaches the lifecycle listener after recovering from an initial restore failure", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const runId = "run-restore-listener";
      const storedTask: TaskRecord = {
        taskId: "task-restore-listener",
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId,
        task: "Resume lifecycle tracking after restore recovery",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 100,
        startedAt: 100,
        lastEventAt: 100,
      };
      let restoreShouldFail = true;
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => {
            if (restoreShouldFail) {
              throw new Error("SQLITE_IOERR: initial task restore failed");
            }
            return {
              tasks: new Map([[storedTask.taskId, storedTask]]),
              deliveryStates: new Map(),
            };
          },
          saveSnapshot: () => {},
        },
      });

      expect(() => getTaskById(storedTask.taskId)).toThrow(
        "Task registry restore failed: SQLITE_IOERR: initial task restore failed",
      );
      restoreShouldFail = false;
      reloadTaskRegistryFromStore();

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });

      expectRecordFields(requireTaskByRunId(runId), {
        status: "succeeded",
        endedAt: 250,
      });
    });
  });

  it("does not hide a failed reload behind the restart-draining delivery fallback", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const storedTask: TaskRecord = {
        taskId: "task-reload-failure",
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-reload-failure",
        task: "Keep restore failures visible",
        status: "succeeded",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: 100,
        endedAt: 200,
        lastEventAt: 200,
      };
      let restoreError: Error | null = null;
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => {
            if (restoreError) {
              throw restoreError;
            }
            return {
              tasks: new Map([[storedTask.taskId, storedTask]]),
              deliveryStates: new Map(),
            };
          },
          saveSnapshot: () => {},
        },
      });
      expect(getTaskById(storedTask.taskId)?.taskId).toBe(storedTask.taskId);

      beginGatewayRestartSignalAdmission();
      const pendingDelivery = maybeDeliverTaskTerminalUpdate(storedTask.taskId);
      await Promise.resolve();

      restoreError = new Error("SQLITE_CORRUPT: task reload failed");
      expect(() => reloadTaskRegistryFromStore()).toThrow(
        "Task registry restore failed: SQLITE_CORRUPT: task reload failed",
      );
      markGatewayRestartDraining();

      await expect(pendingDelivery).rejects.toThrow(
        "Task registry restore failed: SQLITE_CORRUPT: task reload failed",
      );
    });
  });

  it("summarizes inspectable task audit findings", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      const now = Date.now();
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            tasks: new Map([
              [
                "task-audit-summary",
                {
                  taskId: "task-audit-summary",
                  runtime: "acp",
                  requesterSessionKey: "agent:main:main",
                  ownerKey: "agent:main:main",
                  scopeKind: "session",
                  runId: "run-audit-summary",
                  task: "Hung task",
                  status: "running",
                  deliveryStatus: "pending",
                  notifyPolicy: "done_only",
                  createdAt: now - 50 * 60_000,
                  startedAt: now - 40 * 60_000,
                  lastEventAt: now - 40 * 60_000,
                },
              ],
            ]),
            deliveryStates: new Map(),
          }),
          saveSnapshot: () => {},
        },
      });

      expect(getInspectableTaskAuditSummary()).toEqual({
        total: 1,
        warnings: 0,
        errors: 1,
        byCode: {
          stale_queued: 0,
          stale_running: 1,
          lost: 0,
          delivery_failed: 0,
          missing_cleanup: 0,
          inconsistent_timestamps: 0,
        },
      });
    });
  });

  it("delivers concise state-change updates only when notify policy requests them", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "guildchat",
        to: "guildchat:123",
        via: "direct",
      });

      const task = createTaskFixture("acp", {
        deliveryStatus: undefined,
        requesterOrigin: GUILDCHAT_ORIGIN,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-state-change",
        task: "Investigate issue",
        status: "queued",
        notifyPolicy: "done_only",
      });

      markTaskRunningByRunId({
        runId: "run-state-change",
        eventSummary: "Started.",
      });
      await waitForAssertion(() => expect(hoisted.sendMessageMock).not.toHaveBeenCalled());

      updateTaskNotifyPolicyById({
        taskId: task.taskId,
        notifyPolicy: "state_changes",
      });
      recordTaskProgressByRunId({
        runId: "run-state-change",
        eventSummary: "No output for 60s. It may be waiting for input.",
      });

      await waitForAssertion(() =>
        expectRecordFields(sentMessageCall(), {
          content:
            "Background task update: ACP background task. No output for 60s. It may be waiting for input.",
        }),
      );
      expectRecordFields(requireTaskByRunId("run-state-change"), {
        notifyPolicy: "state_changes",
      });
      await maybeDeliverTaskStateChangeUpdate(task.taskId);
      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps background ACP progress off the foreground lane and only sends a terminal notify", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "guildchat",
        to: "guildchat:123",
        via: "direct",
      });
      vi.useFakeTimers();

      createTaskFixture("acp", {
        requesterOrigin: GUILDCHAT_ORIGIN,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-quiet-terminal",
        task: "Create the file",
        deliveryStatus: "pending",
      });

      const relay = startAcpSpawnParentStreamRelay({
        runId: "run-quiet-terminal",
        parentSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child",
        agentId: "codex",
        surfaceUpdates: false,
        streamFlushMs: 1,
        noOutputNoticeMs: 1_000,
        noOutputPollMs: 250,
      });

      relay.notifyStarted();
      emitAgentEvent({
        runId: "run-quiet-terminal",
        stream: "assistant",
        data: {
          delta: "working on it",
        },
      });
      vi.advanceTimersByTime(10);

      expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();

      emitAgentEvent({
        runId: "run-quiet-terminal",
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 250,
        },
      });
      await flushAsyncWork();

      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Background task ready for review: ACP background task (run run-quie). Next: parent will review/verify before calling it done.",
      ]);
      relay.dispose();
      vi.useRealTimers();
    });
  });

  it("delivers a concise terminal failure message without internal ACP chatter", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "guildchat",
        to: "guildchat:123",
        via: "direct",
      });

      createTaskFixture("acp", {
        requesterOrigin: GUILDCHAT_ORIGIN,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-failure-terminal",
        task: "Write the file",
        deliveryStatus: "pending",
        progressSummary:
          "I am loading session context and checking helper availability before writing the file.",
      });

      emitAgentEvent({
        runId: "run-failure-terminal",
        stream: "lifecycle",
        data: {
          phase: "error",
          endedAt: 250,
          error: "Permission denied by ACP runtime",
        },
      });
      await flushAsyncWork();

      expectRecordFields(sentMessageCall(), {
        channel: "guildchat",
        to: "guildchat:123",
        content:
          "Background task failed: ACP background task (run run-fail). Permission denied by ACP runtime",
      });
      expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
    });
  });

  it("emits concise state-change updates without surfacing raw ACP chatter", async () => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryMemoryForTest();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "guildchat",
        to: "guildchat:123",
        via: "direct",
      });
      vi.useFakeTimers();

      createTaskFixture("acp", {
        requesterOrigin: GUILDCHAT_ORIGIN,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-state-stream",
        task: "Create the file",
        deliveryStatus: "pending",
        notifyPolicy: "state_changes",
      });

      const relay = startAcpSpawnParentStreamRelay({
        runId: "run-state-stream",
        parentSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child",
        agentId: "codex",
        surfaceUpdates: false,
        streamFlushMs: 1,
        noOutputNoticeMs: 1_000,
        noOutputPollMs: 250,
      });

      relay.notifyStarted();
      await flushAsyncWork();
      expectRecordFields(sentMessageCall(), {
        content: "Background task update: ACP background task. Started.",
      });

      hoisted.sendMessageMock.mockClear();
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
      expectRecordFields(sentMessageCall(), {
        content:
          "Background task update: ACP background task. No prompt submission observed for 1s after child start.",
      });

      expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
      relay.dispose();
      vi.useRealTimers();
    });
  });

  it("cancels background exec tasks through process control", async () => {
    await withTaskRegistryTempDir(async () => {
      hoisted.cancelBackgroundExecSessionMock.mockReturnValue(true);
      const task = createTaskFixture("cli", {
        taskKind: "exec",
        sourceId: "amber-reef",
        runId: "exec:amber-reef",
        task: "Background CLI command",
      });

      const result = await cancelTask(task.taskId);

      expect(hoisted.cancelBackgroundExecSessionMock).toHaveBeenCalledWith("amber-reef");
      expectRecordFields(result, { found: true, cancelled: true });
      expectRecordFields(result.task, {
        taskId: task.taskId,
        status: "cancelled",
        error: "Cancelled by operator.",
      });
    });
  });

  it("cancels ACP-backed tasks through the ACP session manager", async () => {
    await withTaskRegistryTempDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const task = createTaskFixture("acp", {
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-cancel-acp",
        task: "Investigate issue",
        deliveryStatus: "pending",
      });

      const result = await cancelTask(task.taskId);

      const cancelArgs = firstMockArg(hoisted.cancelSessionMock, "cancelSession");
      expectRecordFields(cancelArgs, {
        cfg: {},
        sessionKey: "agent:codex:acp:child",
        reason: "task-cancel",
      });
      expectRecordFields(result, {
        found: true,
        cancelled: true,
      });
      expectRecordFields(result.task, {
        taskId: task.taskId,
        status: "cancelled",
        error: "Cancelled by operator.",
      });
      await waitForAssertion(() =>
        expectRecordFields(sentMessageCall(), {
          channel: "notifychat",
          to: "notifychat:123",
          content: "Background task cancelled: ACP background task (run run-canc).",
        }),
      );
    });
  });

  it("cancels subagent-backed tasks through subagent control", async () => {
    await withTaskRegistryTempDir(async () => {
      const silentTask = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:child",
        runId: "run-cancel-subagent",
        task: "Silent projection",
        notifyPolicy: "silent",
      });
      const task = createTaskFixture("subagent", {
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        childSessionKey: "agent:worker:subagent:child",
        runId: "run-cancel-subagent",
        task: "Investigate issue",
        deliveryStatus: "pending",
      });
      const peerTask = createTaskFixture("subagent", {
        requesterOrigin: NOTIFYCHAT_ORIGIN,
        childSessionKey: "agent:worker:subagent:child",
        runId: "run-cancel-subagent",
        task: "Peer projection",
        deliveryStatus: "pending",
      });
      hoisted.killSubagentRunAdminMock.mockImplementationOnce(async () => {
        finalizeSubagentTask(task, {
          status: "cancelled",
          endedAt: 200,
          error: SUBAGENT_KILL_TASK_ERROR,
        });
        return { found: true, killed: true };
      });

      const result = await cancelTask(task.taskId);

      const killArgs = firstMockArg(hoisted.killSubagentRunAdminMock, "killSubagentRunAdmin");
      expectRecordFields(killArgs, {
        cfg: {},
        sessionKey: "agent:worker:subagent:child",
      });
      expectRecordFields(result, {
        found: true,
        cancelled: true,
      });
      expectRecordFields(result.task, {
        taskId: task.taskId,
        status: "cancelled",
        error: "Cancelled by operator.",
      });
      expectRecordFields(getTaskById(peerTask.taskId), {
        status: "cancelled",
        error: "Cancelled by operator.",
      });
      expectRecordFields(getTaskById(silentTask.taskId), {
        status: "cancelled",
        deliveryStatus: "not_applicable",
        error: "Cancelled by operator.",
      });
      await waitForAssertion(() =>
        expectRecordFields(sentMessageCall(), {
          channel: "notifychat",
          to: "notifychat:123",
          content: "Background task cancellation requested: Subagent task (run run-canc).",
        }),
      );
      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  it("promotes a provisional subagent kill that races task cancellation", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:concurrent-kill",
        runId: "run-subagent-concurrent-kill",
        task: "Cancel during teardown",
      });
      hoisted.killSubagentRunAdminMock.mockImplementationOnce(async () => {
        finalizeSubagentTask(task, {
          status: "cancelled",
          endedAt: 200,
          error: SUBAGENT_KILL_TASK_ERROR,
        });
        return { found: true, killed: false };
      });

      const result = await cancelTask(task.taskId);
      finalizeSubagentTask(task, {
        status: "succeeded",
        endedAt: 201,
        terminalSummary: "completed too late",
      });

      expectRecordFields(result, { found: true, cancelled: true });
      expectRecordFields(getTaskById(task.taskId), {
        status: "cancelled",
        endedAt: 200,
        error: "Cancelled by operator.",
        terminalSummary: undefined,
      });
    });
  });

  it("reconciles an already-provisional kill before making cancellation sticky", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:provisional-completion",
        runId: "run-subagent-provisional-completion",
        task: "Finish before explicit cancellation",
      });
      finalizeSubagentTask(task, {
        status: "cancelled",
        endedAt: 200,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      hoisted.killSubagentRunAdminMock.mockResolvedValueOnce({
        found: true,
        killed: false,
        runId: task.runId!,
        sessionKey: task.childSessionKey!,
        cascadeKilled: 0,
        targetState: {
          state: "terminal",
          task: {
            status: "succeeded",
            endedAt: 201,
            terminalSummary: "completed",
          },
        },
      });

      const result = await cancelTask(task.taskId);

      expect(hoisted.killSubagentRunAdminMock).toHaveBeenCalledOnce();
      expectRecordFields(result, {
        found: true,
        cancelled: false,
        reason: "Subagent completed while cancellation was in progress.",
      });
      expectRecordFields(getTaskById(task.taskId), {
        status: "succeeded",
        endedAt: 201,
        error: undefined,
        terminalSummary: "completed",
      });
    });
  });

  it("preserves subagent success that completes during cancellation", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:cancel-race",
        runId: "run-subagent-cancel-race",
        task: "Finish during cancellation",
      });
      const peerTask = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:cancel-race",
        runId: "run-subagent-cancel-race",
        task: "Peer projection",
      });
      hoisted.killSubagentRunAdminMock.mockImplementationOnce(async () => {
        finalizeSubagentTask(task, {
          status: "cancelled",
          endedAt: 200,
          error: SUBAGENT_KILL_TASK_ERROR,
        });
        finalizeSubagentTask(task, {
          status: "succeeded",
          endedAt: 201,
          terminalSummary: "completed",
        });
        return { found: true, killed: true };
      });

      const result = await cancelTask(task.taskId);

      expectRecordFields(result, {
        found: true,
        cancelled: false,
        reason: "Subagent completed while cancellation was in progress.",
      });
      expectRecordFields(result.task, {
        status: "succeeded",
        error: undefined,
        terminalSummary: "completed",
      });
      expectRecordFields(getTaskById(peerTask.taskId), {
        status: "succeeded",
        error: undefined,
        terminalSummary: "completed",
      });
    });
  });

  it("does not cancel a lagging task projection after subagent completion wins", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:lagging-projection",
        runId: "run-subagent-lagging-projection",
        task: "Finish before task projection",
      });
      hoisted.killSubagentRunAdminMock.mockResolvedValueOnce({
        found: true,
        killed: false,
        runId: task.runId!,
        sessionKey: task.childSessionKey!,
        cascadeKilled: 0,
        targetState: {
          state: "terminal",
          task: {
            status: "succeeded",
            endedAt: 200,
            progressSummary: "final answer",
            terminalSummary: "final answer",
            terminalOutcome: "blocked",
          },
        },
      });

      const result = await cancelTask(task.taskId);

      expectRecordFields(result, {
        found: true,
        cancelled: false,
        reason: "Subagent completed while cancellation was in progress.",
      });
      expectRecordFields(result.task, {
        status: "succeeded",
        endedAt: 200,
        progressSummary: "final answer",
        terminalSummary: "final answer",
        terminalOutcome: "blocked",
      });
    });
  });

  it("reconciles a replacement run cancellation into the original task scope", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:replacement-run",
        runId: "run-subagent-before-replacement",
        task: "Cancel after recovery",
      });
      hoisted.killSubagentRunAdminMock.mockResolvedValueOnce({
        found: true,
        killed: true,
        runId: "run-subagent-after-replacement",
        sessionKey: task.childSessionKey!,
        cascadeKilled: 0,
        targetState: {
          state: "terminal",
          task: {
            status: "cancelled",
            endedAt: 200,
            error: SUBAGENT_KILL_TASK_ERROR,
          },
        },
      });

      const result = await cancelTask(task.taskId);

      expectRecordFields(result, { found: true, cancelled: true });
      expectRecordFields(getTaskById(task.taskId), {
        status: "cancelled",
        endedAt: 200,
        error: "Cancelled by operator.",
      });
    });
  });

  it("ignores a stale killed snapshot after canonical completion persists", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:stale-kill-snapshot",
        runId: "run-subagent-stale-kill-snapshot",
        task: "Complete while admin kill unwinds",
      });
      hoisted.killSubagentRunAdminMock.mockImplementationOnce(async () => {
        finalizeSubagentTask(task, {
          status: "succeeded",
          endedAt: 201,
          terminalSummary: "completed",
        });
        return {
          found: true,
          killed: false,
          runId: task.runId!,
          sessionKey: task.childSessionKey!,
          cascadeKilled: 0,
          targetState: {
            state: "terminal" as const,
            task: {
              status: "cancelled" as const,
              endedAt: 200,
              error: SUBAGENT_KILL_TASK_ERROR,
              terminalSummary: null,
            },
          },
        };
      });

      const result = await cancelTask(task.taskId);

      expectRecordFields(result, {
        found: true,
        cancelled: false,
        reason: "Subagent completed while cancellation was in progress.",
      });
      expectRecordFields(getTaskById(task.taskId), {
        status: "succeeded",
        endedAt: 201,
        error: undefined,
        terminalSummary: "completed",
      });
    });
  });

  it("promotes an already-killed run projection during task cancellation", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:killed-projection",
        runId: "run-subagent-killed-projection",
        task: "Repair and cancel killed projection",
      });
      hoisted.killSubagentRunAdminMock.mockResolvedValueOnce({
        found: true,
        killed: false,
        runId: task.runId!,
        sessionKey: task.childSessionKey!,
        cascadeKilled: 0,
        targetState: {
          state: "terminal",
          task: {
            status: "cancelled",
            endedAt: 200,
            error: SUBAGENT_KILL_TASK_ERROR,
            terminalSummary: null,
          },
        },
      });

      const result = await cancelTask(task.taskId);
      finalizeSubagentTask(task, {
        status: "succeeded",
        endedAt: 201,
        terminalSummary: "completed too late",
      });

      expectRecordFields(result, { found: true, cancelled: true });
      expectRecordFields(getTaskById(task.taskId), {
        status: "cancelled",
        endedAt: 200,
        error: "Cancelled by operator.",
        terminalSummary: undefined,
      });
    });
  });

  it("reports when terminal reconciliation cannot be persisted", async () => {
    await withTaskRegistryTempDir(async () => {
      const store = createInMemoryTaskRegistryStore();
      configureTaskRegistryRuntime({ store });
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:persist-failure",
        runId: "run-subagent-persist-failure",
        task: "Finish before persistence fails",
      });
      configureTaskRegistryRuntime({
        store: {
          ...store,
          upsertTaskWithDeliveryState: () => {
            throw new Error("task store unavailable");
          },
        },
      });
      hoisted.killSubagentRunAdminMock.mockResolvedValueOnce({
        found: true,
        killed: false,
        runId: task.runId!,
        sessionKey: task.childSessionKey!,
        cascadeKilled: 0,
        targetState: {
          state: "terminal",
          task: { status: "succeeded", endedAt: 200, terminalSummary: "done" },
        },
      });

      const result = await cancelTask(task.taskId);

      expectRecordFields(result, {
        found: true,
        cancelled: false,
        reason: "Subagent became terminal, but task state reconciliation failed to persist.",
      });
      expectRecordFields(result.task, { status: "running" });
    });
  });

  it("returns a subagent failure that wins during cancellation", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:failed-race",
        runId: "run-subagent-failed-race",
        task: "Fail during cancellation",
      });
      hoisted.killSubagentRunAdminMock.mockImplementationOnce(async () => {
        return {
          found: true,
          killed: false,
          runId: task.runId!,
          sessionKey: task.childSessionKey!,
          cascadeKilled: 0,
          targetState: {
            state: "terminal",
            task: {
              status: "failed",
              endedAt: 200,
              error: "provider failed",
              progressSummary: "partial work",
              terminalSummary: null,
            },
          },
        };
      });

      const result = await cancelTask(task.taskId);

      expectRecordFields(result, {
        found: true,
        cancelled: false,
        reason: "Subagent became failed while cancellation was in progress.",
      });
      expectRecordFields(result.task, {
        status: "failed",
        endedAt: 200,
        error: "provider failed",
        progressSummary: "partial work",
      });
    });
  });

  it("defers cancellation while canonical subagent completion is still finalizing", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:finalizing-race",
        runId: "run-subagent-finalizing-race",
        task: "Capture final result",
      });
      hoisted.killSubagentRunAdminMock.mockResolvedValueOnce({
        found: true,
        killed: false,
        runId: task.runId!,
        sessionKey: task.childSessionKey!,
        cascadeKilled: 0,
        targetState: { state: "finalizing" },
      });

      const result = await cancelTask(task.taskId);

      expectRecordFields(result, {
        found: true,
        cancelled: false,
        reason: "Subagent completion is still being finalized.",
      });
      expectRecordFields(result.task, { status: "running" });
    });
  });

  it("keeps subagent cancellation terminal when success arrives after cancellation", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:late-success",
        runId: "run-subagent-late-success",
        task: "Finish after cancellation",
      });
      hoisted.killSubagentRunAdminMock.mockImplementationOnce(async () => {
        finalizeSubagentTask(task, {
          status: "cancelled",
          endedAt: 200,
          error: SUBAGENT_KILL_TASK_ERROR,
        });
        return { found: true, killed: true };
      });

      const result = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
        reason: SUBAGENT_KILL_TASK_ERROR,
      });
      finalizeSubagentTask(task, {
        status: "succeeded",
        endedAt: 201,
        terminalSummary: "completed too late",
      });

      expectRecordFields(result, { found: true, cancelled: true });
      expectRecordFields(getTaskById(task.taskId), {
        status: "cancelled",
        error: "Cancelled by operator.",
        terminalSummary: undefined,
      });
    });
  });

  it("accepts subagent success that completed before cancellation", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:earlier-success",
        runId: "run-subagent-earlier-success",
        task: "Finish before cancellation",
      });
      finalizeSubagentTask(task, {
        status: "cancelled",
        endedAt: 200,
        error: "Cancelled by operator.",
      });

      finalizeSubagentTask(task, {
        status: "succeeded",
        endedAt: 199,
        terminalSummary: "completed before cancellation",
      });

      expectRecordFields(getTaskById(task.taskId), {
        status: "succeeded",
        endedAt: 199,
        error: undefined,
        terminalSummary: "completed before cancellation",
      });
    });
  });

  it("does not let a repeated kill restore the provisional marker after cancellation", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:repeated-kill",
        runId: "run-subagent-repeated-kill",
        task: "Stay cancelled",
      });
      for (const error of [
        SUBAGENT_KILL_TASK_ERROR,
        "Cancelled by operator.",
        SUBAGENT_KILL_TASK_ERROR,
      ]) {
        finalizeSubagentTask(task, {
          status: "cancelled",
          endedAt: 200,
          error,
        });
      }

      expectRecordFields(getTaskById(task.taskId), {
        status: "cancelled",
        error: "Cancelled by operator.",
      });
    });
  });

  it("promotes an existing subagent kill marker to operator cancellation", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:already-killed",
        runId: "run-subagent-already-killed",
        task: "Promote killed task",
      });
      const peerTask = createTaskFixture("subagent", {
        childSessionKey: "agent:worker:subagent:already-killed",
        runId: "run-subagent-already-killed",
        task: "Peer projection",
      });
      finalizeSubagentTask(task, {
        status: "cancelled",
        endedAt: 200,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      hoisted.killSubagentRunAdminMock.mockClear();
      hoisted.killSubagentRunAdminMock.mockResolvedValueOnce({
        found: true,
        killed: false,
        runId: task.runId!,
        sessionKey: task.childSessionKey!,
        cascadeKilled: 0,
        targetState: {
          state: "terminal",
          task: {
            status: "cancelled",
            endedAt: 200,
            error: SUBAGENT_KILL_TASK_ERROR,
          },
        },
      });

      const result = await cancelTask(task.taskId);
      finalizeSubagentTask(task, {
        status: "succeeded",
        endedAt: 201,
        terminalSummary: "completed too late",
      });

      expect(hoisted.killSubagentRunAdminMock).toHaveBeenCalledOnce();
      expectRecordFields(result, { found: true, cancelled: true });
      for (const taskId of [task.taskId, peerTask.taskId]) {
        expectRecordFields(getTaskById(taskId), {
          status: "cancelled",
          endedAt: 200,
          error: "Cancelled by operator.",
          terminalSummary: undefined,
        });
      }
    });
  });

  it("suppresses terminal delivery when teardown finalizes a killed task", async () => {
    await withTaskRegistryTempDir(async () => {
      hoisted.sendMessageMock.mockClear();
      const task = createTaskFixture("subagent", {
        requesterOrigin: { channel: "notifychat", to: "notifychat:123" },
        childSessionKey: "agent:worker:subagent:teardown",
        runId: "run-subagent-teardown",
        task: "Stop silently",
        deliveryStatus: "pending",
      });

      finalizeSubagentTask(task, {
        status: "cancelled",
        endedAt: 200,
        error: SUBAGENT_KILL_TASK_ERROR,
        suppressDelivery: true,
      });
      finalizeSubagentTask(task, {
        status: "cancelled",
        endedAt: 201,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      await Promise.resolve();

      expectRecordFields(getTaskById(task.taskId), {
        status: "cancelled",
        error: SUBAGENT_KILL_TASK_ERROR,
        deliveryStatus: "not_applicable",
      });
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  it("stops a pending terminal notifier when teardown suppresses delivery", async () => {
    await withTaskRegistryTempDir(async () => {
      hoisted.sendMessageMock.mockClear();
      const task = createTaskFixture("subagent", {
        requesterOrigin: { channel: "notifychat", to: "notifychat:123" },
        childSessionKey: "agent:worker:subagent:pending-teardown",
        runId: "run-subagent-pending-teardown",
        task: "Stop pending delivery",
        deliveryStatus: "pending",
      });
      finalizeSubagentTask(task, {
        status: "cancelled",
        endedAt: 200,
        error: SUBAGENT_KILL_TASK_ERROR,
      });

      const pendingDelivery = maybeDeliverTaskTerminalUpdate(task.taskId);
      finalizeSubagentTask(task, {
        status: "cancelled",
        endedAt: 201,
        error: SUBAGENT_KILL_TASK_ERROR,
        suppressDelivery: true,
      });
      await pendingDelivery;

      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
      expectRecordFields(getTaskById(task.taskId), {
        status: "cancelled",
        deliveryStatus: "not_applicable",
      });
    });
  });

  it.each([
    {
      name: "cancels CLI-tracked tasks in the registry without ACP or subagent teardown",
      runId: "run-cancel-cli",
      task: "Investigate issue",
      childSessionKey: "agent:main:main",
      expectedError: "Cancelled by operator.",
      expectedMessage: "Background task cancelled: Investigate issue (run run-canc).",
    },
    {
      name: "cancels CLI-tracked tasks without childSessionKey",
      runId: "run-cli-no-child",
      task: "Legacy row",
      childSessionKey: undefined,
      expectedError: undefined,
      expectedMessage: undefined,
    },
  ])(
    "$name",
    async ({ runId, task: taskName, childSessionKey, expectedError, expectedMessage }) => {
      await withTaskRegistryTempDir(async () => {
        const task = createTaskFixture("cli", {
          requesterOrigin: NOTIFYCHAT_ORIGIN,
          childSessionKey,
          runId,
          task: taskName,
          deliveryStatus: "pending",
        });
        const result = await cancelTask(task.taskId);

        expectRecordFields(result, { found: true, cancelled: true });
        expectRecordFields(result.task, {
          taskId: task.taskId,
          status: "cancelled",
          ...(expectedError === undefined ? {} : { error: expectedError }),
        });
        if (expectedMessage !== undefined) {
          expect(hoisted.cancelSessionMock).not.toHaveBeenCalled();
          expect(hoisted.killSubagentRunAdminMock).not.toHaveBeenCalled();
          await waitForAssertion(() =>
            expectRecordFields(sentMessageCall(), {
              channel: "notifychat",
              to: "notifychat:123",
              content: expectedMessage,
            }),
          );
        }
      });
    },
  );

  it("cancels active cron tasks through the cron runtime abort handle", async () => {
    await withTaskRegistryTempDir(async () => {
      const abortController = new AbortController();
      const task = createTaskFixture("cron", {
        sourceId: "nightly-gmail-sync",
        ownerKey: "",
        scopeKind: "system",
        runId: "cron:nightly-gmail-sync:123",
        task: "Nightly Gmail sync",
        notifyPolicy: "silent",
      });
      hoisted.cancelActiveCronTaskRunMock.mockImplementation(({ reason }: { reason?: string }) => {
        abortController.abort(reason);
        return true;
      });

      const result = await cancelTask(task.taskId);

      expect(hoisted.cancelActiveCronTaskRunMock).toHaveBeenCalledWith({
        runId: "cron:nightly-gmail-sync:123",
        reason: "Cancelled by operator.",
      });
      expect(abortController.signal.aborted).toBe(true);
      expect(abortController.signal.reason).toBe("Cancelled by operator.");
      expectRecordFields(result, {
        found: true,
        cancelled: true,
      });
      expectRecordFields(result.task, {
        taskId: task.taskId,
        runtime: "cron",
        status: "cancelled",
        error: "Cancelled by operator.",
      });
    });
  });

  it("refuses terminal and unknown cron task cancellation before runtime dispatch", async () => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("cron", {
        sourceId: "finished-cron",
        ownerKey: "",
        scopeKind: "system",
        runId: "cron:finished-cron:123",
        task: "Finished cron",
        status: "succeeded",
        notifyPolicy: "silent",
      });

      await expect(cancelTask(task.taskId)).resolves.toMatchObject({
        found: true,
        cancelled: false,
        reason: "Task is already terminal.",
      });
      await expect(
        cancelTaskById({ cfg: {} as never, taskId: "unknown-cron-task" }),
      ).resolves.toMatchObject({
        found: false,
        cancelled: false,
        reason: "Task not found.",
      });
      expect(hoisted.cancelActiveCronTaskRunMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "cancels stale cron tasks without an active runtime abort handle",
      childSessionKey: undefined,
      cancelled: true,
      reason: undefined,
      status: "cancelled",
      error: "Cancelled by operator.",
    },
    {
      name: "does not mark session-backed cron tasks cancelled without an active runtime abort handle",
      childSessionKey: "agent:main:cron:daily-repost",
      cancelled: false,
      reason: "Cron task has no active cancellation handle.",
      status: "running",
      error: undefined,
    },
  ])("$name", async ({ childSessionKey, cancelled, reason, status, error }) => {
    await withTaskRegistryTempDir(async () => {
      const task = createTaskFixture("cron", {
        sourceId: "daily-repost",
        ownerKey: "",
        scopeKind: "system",
        childSessionKey,
        runId: "cron:daily-repost:123",
        task: "Daily repost",
        notifyPolicy: "silent",
      });
      const result = await cancelTask(task.taskId);

      expectRecordFields(result, {
        found: true,
        cancelled,
        ...(reason === undefined ? {} : { reason }),
      });
      expectRecordFields(result.task, {
        taskId: task.taskId,
        runtime: "cron",
        status,
        ...(error === undefined ? {} : { error }),
      });
    });
  });

  it.each([
    {
      name: "cancels childless codex-native tasks without routing through OpenClaw subagent sessions",
      taskKind: "codex-native",
      sourceId: "codex-thread:child-thread",
      task: "Codex native child",
      cancellable: true,
    },
    {
      name: "cancels childless copilot-native tasks without routing through OpenClaw subagent sessions",
      taskKind: "copilot-native",
      sourceId: "copilot-agent:child-agent",
      task: "Copilot native child",
      cancellable: true,
    },
    {
      name: "does not cancel unrelated childless subagent tasks",
      taskKind: "codex-native",
      sourceId: "other-runtime:child-thread",
      task: "Non-Codex childless row",
      cancellable: false,
    },
  ])("$name", async ({ taskKind, sourceId, task: taskName, cancellable }) => {
    await withTaskRegistryTempDir(async () => {
      resetTaskRegistryForTests();
      const task = createTaskFixture("subagent", {
        taskKind,
        sourceId,
        runId: sourceId,
        task: taskName,
        notifyPolicy: "silent",
      });
      const result = await cancelTask(task.taskId);

      if (!cancellable) {
        expect(result).toEqual({
          found: true,
          cancelled: false,
          reason: "Task has no cancellable child session.",
          task,
        });
      } else {
        expectRecordFields(result, { found: true, cancelled: true });
        expectRecordFields(result.task, {
          taskId: task.taskId,
          status: "cancelled",
          endedAt: expect.any(Number),
          lastEventAt: expect.any(Number),
          cleanupAfter: expect.any(Number),
          error: "Cancelled by operator.",
        });
      }
      expect(hoisted.killSubagentRunAdminMock).not.toHaveBeenCalled();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
