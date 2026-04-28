import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import { startAcpSpawnParentStreamRelay } from "../agents/acp-spawn-parent-stream.js";
import { resetCronActiveJobsForTests } from "../cron/active-jobs.js";
import {
  emitAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import {
  hasPendingHeartbeatWake,
  resetHeartbeatWakeStateForTests,
} from "../infra/heartbeat-wake.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createManagedTaskFlow, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import {
  cancelTaskById,
  createTaskRecord,
  findLatestTaskForOwnerKey,
  findLatestTaskForRelatedSessionKey,
  findTaskByRunId,
  getTaskById,
  getTaskRegistrySummary,
  isParentFlowLinkError,
  listTasksForOwnerKey,
  listTaskRecords,
  linkTaskToFlowById,
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
  markTaskRunningByRunId,
  markTaskTerminalById,
  markTaskTerminalByRunId,
  recordTaskProgressByRunId,
  reloadTaskRegistryFromStore,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  resolveTaskForLookupToken,
  setTaskRegistryControlRuntimeForTests,
  setTaskRegistryDeliveryRuntimeForTests,
  setTaskProgressById,
  setTaskTimingById,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import {
  getInspectableTaskAuditSummary,
  previewTaskRegistryMaintenance,
  resetTaskRegistryMaintenanceRuntimeForTests,
  reconcileInspectableTasks,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceRuntimeForTests,
  startTaskRegistryMaintenance,
  stopTaskRegistryMaintenanceForTests,
  sweepTaskRegistry,
} from "./task-registry.maintenance.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  return {
    sendMessageMock,
    cancelSessionMock,
    killSubagentRunAdminMock,
  };
});

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
    channel === "notifychat" || channel === "guildchat",
}));

function configureTaskRegistryMaintenanceRuntimeForTest(params: {
  currentTasks: Map<string, ReturnType<typeof createTaskRecord>>;
  snapshotTasks: ReturnType<typeof createTaskRecord>[];
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
    readAcpSessionEntry: () => emptyAcpEntry,
    loadSessionStore: () => ({}),
    resolveStorePath: () => "",
    parseAgentSessionKey: () => null as ParsedAgentSessionKey | null,
    isCronJobActive: () => false,
    getAgentRunContext: () => undefined,
    deleteTaskRecordById: (taskId: string) => params.currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => params.currentTasks.get(taskId),
    listTaskRecords: () => params.snapshotTasks,
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
    isCronRuntimeAuthoritative: () => true,
    resolveCronStorePath: () => "/tmp/openclaw-test-cron/jobs.json",
    loadCronStoreSync: () => ({ version: 1, jobs: [] }),
    resolveCronRunLogPath: ({ jobId }) => jobId,
    readCronRunLogEntriesSync: () => [],
  });
}

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 5) {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }
}

async function flushAsyncWork(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

async function withTaskRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
    try {
      return await run(root);
    } finally {
      // Close both sqlite-backed registries before Windows temp-dir cleanup tries to remove them.
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
    }
  });
}

function configureInMemoryTaskStoresForLinkValidationTests() {
  configureTaskRegistryRuntime({
    store: {
      loadSnapshot: () => ({
        tasks: new Map(),
        deliveryStates: new Map(),
      }),
      saveSnapshot: () => {},
      upsertTask: () => {},
      deleteTask: () => {},
      close: () => {},
    },
  });
  configureTaskFlowRegistryRuntime({
    store: {
      loadSnapshot: () => ({
        flows: new Map(),
      }),
      saveSnapshot: () => {},
      upsertFlow: () => {},
      deleteFlow: () => {},
      close: () => {},
    },
  });
}

describe("task-registry", () => {
  beforeEach(() => {
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage: hoisted.sendMessageMock,
    });
    setTaskRegistryControlRuntimeForTests({
      getAcpSessionManager: () => ({
        cancelSession: hoisted.cancelSessionMock,
      }),
      killSubagentRunAdmin: async (params) => hoisted.killSubagentRunAdminMock(params),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetAgentRunContextForTest();
    resetCronActiveJobsForTests();
    resetTaskRegistryControlRuntimeForTests();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryMaintenanceRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    hoisted.sendMessageMock.mockReset();
    hoisted.cancelSessionMock.mockReset();
    hoisted.killSubagentRunAdminMock.mockReset();
  });

  it("updates task status from lifecycle events", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:acp:child",
        runId: "run-1",
        task: "Do the thing",
        status: "running",
        deliveryStatus: "not_applicable",
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

      expect(findTaskByRunId("run-1")).toMatchObject({
        runtime: "acp",
        status: "succeeded",
        endedAt: 250,
      });
    });
  });

  it("ignores late agent events for operator-cancelled tasks", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:main",
        runId: "run-cancel-then-end",
        task: "Do the thing",
        status: "running",
        deliveryStatus: "not_applicable",
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

      expect(findTaskByRunId("run-cancel-then-end")).toMatchObject({
        status: "cancelled",
        endedAt: 200,
        lastEventAt: 200,
        error: "Cancelled by operator.",
      });
    });
  });

  it("keeps stronger run-scoped terminal states when a late success arrives", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:main",
        runId: "run-timeout-then-success",
        task: "Do the thing",
        status: "running",
        deliveryStatus: "not_applicable",
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
      markTaskTerminalByRunId({
        runId: "run-timeout-then-success",
        runtime: "cli",
        status: "succeeded",
        endedAt: 300,
        terminalSummary: "completed",
      });

      expect(findTaskByRunId("run-timeout-then-success")).toMatchObject({
        status: "timed_out",
        endedAt: 200,
      });
    });
  });

  it("does not downgrade failed run-scoped tasks when a late success arrives", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:main",
        runId: "run-fail-then-success",
        task: "Deliver result",
        status: "running",
        deliveryStatus: "not_applicable",
        startedAt: 100,
      });

      markTaskTerminalByRunId({
        runId: "run-fail-then-success",
        runtime: "cli",
        status: "failed",
        endedAt: 200,
        error: "delivery failed",
      });
      markTaskTerminalByRunId({
        runId: "run-fail-then-success",
        runtime: "cli",
        status: "succeeded",
        endedAt: 300,
        terminalSummary: "completed",
      });

      expect(findTaskByRunId("run-fail-then-success")).toMatchObject({
        status: "failed",
        endedAt: 200,
        error: "delivery failed",
      });
    });
  });

  it("lets delivery failure upgrade a lifecycle success", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:main",
        runId: "run-success-then-fail",
        task: "Deliver result",
        status: "running",
        deliveryStatus: "not_applicable",
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
      markTaskTerminalByRunId({
        runId: "run-success-then-fail",
        runtime: "cli",
        status: "failed",
        endedAt: 300,
        error: "delivery failed",
      });

      expect(findTaskByRunId("run-success-then-fail")).toMatchObject({
        status: "failed",
        endedAt: 300,
        error: "delivery failed",
      });
    });
  });

  it("summarizes task pressure by status and runtime", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-summary-acp",
        task: "Investigate issue",
        status: "queued",
        deliveryStatus: "pending",
      });
      createTaskRecord({
        runtime: "cron",
        ownerKey: "",
        scopeKind: "system",
        runId: "run-summary-cron",
        task: "Daily digest",
        status: "running",
        deliveryStatus: "not_applicable",
      });
      createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-summary-subagent",
        task: "Write patch",
        status: "timed_out",
        deliveryStatus: "session_queued",
      });

      expect(getTaskRegistrySummary()).toEqual({
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

  it("rejects cross-owner parent flow links during task creation", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-registry",
        goal: "Owner main flow",
      });

      expect(() =>
        createTaskRecord({
          runtime: "acp",
          ownerKey: "agent:main:other",
          scopeKind: "session",
          parentFlowId: flow.flowId,
          runId: "cross-owner-run",
          task: "Attempt hijack",
        }),
      ).toThrow("Task ownerKey must match parent flow ownerKey.");
    });
  });

  it("rejects system-scoped parent flow links during task creation", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-registry",
        goal: "Owner main flow",
      });

      expect(() =>
        createTaskRecord({
          runtime: "cron",
          ownerKey: "agent:main:main",
          scopeKind: "system",
          parentFlowId: flow.flowId,
          runId: "system-link-run",
          task: "System task",
          deliveryStatus: "not_applicable",
        }),
      ).toThrow("Only session-scoped tasks can link to flows.");
    });
  });

  it("rejects cross-owner flow links for existing tasks", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const task = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
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
      expect(getTaskById(task.taskId)).toMatchObject({
        taskId: task.taskId,
        parentFlowId: undefined,
      });
    });
  });

  it("rejects parent flow links once cancellation has been requested", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-registry",
        goal: "Cancelling flow",
        cancelRequestedAt: 42,
      });

      try {
        createTaskRecord({
          runtime: "acp",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          parentFlowId: flow.flowId,
          runId: "cancel-requested-link",
          task: "Should be denied",
        });
        throw new Error("Expected createTaskRecord to throw.");
      } catch (error) {
        expect(isParentFlowLinkError(error)).toBe(true);
        expect(error).toMatchObject({
          code: "cancel_requested",
          message: "Parent flow cancellation has already been requested.",
        });
      }
    });
  });

  it("rejects parent flow links for terminal flows", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-registry",
        goal: "Completed flow",
        status: "cancelled",
      });

      expect(() =>
        createTaskRecord({
          runtime: "acp",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          parentFlowId: flow.flowId,
          runId: "terminal-flow-link",
          task: "Should be denied",
        }),
      ).toThrow("Parent flow is already cancelled.");
    });
  });

  it("delivers ACP completion to the requester channel when a delivery origin exists", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
          threadId: "321",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-delivery",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
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
        expect(findTaskByRunId("run-delivery")).toMatchObject({
          status: "succeeded",
          deliveryStatus: "delivered",
        }),
      );
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "notifychat",
            to: "notifychat:123",
            threadId: "321",
            content: expect.stringContaining("Background task done: ACP background task"),
            mirror: expect.objectContaining({
              sessionKey: "agent:main:main",
            }),
          }),
        ),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("records delivery failure and queues a session fallback when direct delivery misses", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockRejectedValueOnce(new Error("notifychat unavailable"));

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-delivery-fail",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
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
        expect(findTaskByRunId("run-delivery-fail")).toMatchObject({
          status: "failed",
          deliveryStatus: "failed",
          error: "Permission denied by ACP runtime",
        }),
      );
      await waitForAssertion(() =>
        expect(peekSystemEvents("agent:main:main")).toEqual([
          expect.stringContaining("Background task failed: ACP background task"),
        ]),
      );
    });
  });

  it("still wakes the parent when blocked delivery misses the outward channel", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockRejectedValueOnce(new Error("notifychat unavailable"));

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-delivery-blocked",
        task: "Port the repo changes",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-delivery-blocked")).toMatchObject({
          status: "succeeded",
          deliveryStatus: "failed",
          terminalOutcome: "blocked",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Background task blocked: ACP background task (run run-deli). Writable session or apply_patch authorization required.",
        "Task needs follow-up: ACP background task (run run-deli). Writable session or apply_patch authorization required.",
      ]);
      expect(hasPendingHeartbeatWake()).toBe(true);
    });
  });

  it("marks internal fallback delivery as session queued instead of delivered", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:acp:child",
        runId: "run-session-queued",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
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
        expect(findTaskByRunId("run-session-queued")).toMatchObject({
          status: "succeeded",
          deliveryStatus: "session_queued",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        expect.stringContaining("Background task done: ACP background task"),
      ]);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  it("wakes the parent for blocked tasks even when delivery falls back to the session", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:acp:child",
        runId: "run-session-blocked",
        task: "Port the repo changes",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-session-blocked")).toMatchObject({
          status: "succeeded",
          deliveryStatus: "session_queued",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Background task blocked: ACP background task (run run-sess). Writable session or apply_patch authorization required.",
        "Task needs follow-up: ACP background task (run run-sess). Writable session or apply_patch authorization required.",
      ]);
      expect(hasPendingHeartbeatWake()).toBe(true);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  it("does not include internal progress detail in the terminal channel message", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
          threadId: "321",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-detail-leak",
        task: "Create the file and verify it",
        status: "running",
        deliveryStatus: "pending",
        startedAt: 100,
      });

      setTaskProgressById({
        taskId: findTaskByRunId("run-detail-leak")!.taskId,
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

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content: "Background task done: ACP background task (run run-deta).",
          }),
        ),
      );
    });
  });

  it("surfaces blocked outcomes separately from completed tasks", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-blocked-outcome",
        task: "Port the repo changes",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Background task blocked: ACP background task (run run-bloc). Writable session or apply_patch authorization required.",
          }),
        ),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Task needs follow-up: ACP background task (run run-bloc). Writable session or apply_patch authorization required.",
      ]);
      expect(hasPendingHeartbeatWake()).toBe(true);
    });
  });

  it("does not queue an unblock follow-up for ordinary completed tasks", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-succeeded-outcome",
        task: "Create the file and verify it",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalSummary: "Created /tmp/file.txt and verified contents.",
        terminalOutcome: "succeeded",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Background task done: ACP background task (run run-succ). Created /tmp/file.txt and verified contents.",
          }),
        ),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      expect(hasPendingHeartbeatWake()).toBe(false);
    });
  });

  it("keeps distinct task records when different producers share a runId", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:codex:acp:child",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-shared",
        task: "Child ACP execution",
        status: "running",
        deliveryStatus: "not_applicable",
      });

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-shared",
        task: "Spawn ACP child",
        status: "running",
        deliveryStatus: "pending",
      });

      expect(listTaskRecords().filter((task) => task.runId === "run-shared")).toHaveLength(2);
      expect(findTaskByRunId("run-shared")).toMatchObject({
        runtime: "acp",
        task: "Spawn ACP child",
      });
    });
  });

  it("scopes shared-run lifecycle events to the matching session", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const victimTask = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:victim:main",
        scopeKind: "session",
        childSessionKey: "agent:victim:acp:child",
        runId: "run-shared-scope",
        task: "Victim ACP task",
        status: "running",
        deliveryStatus: "pending",
      });

      const attackerTask = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:attacker:main",
        scopeKind: "session",
        childSessionKey: "agent:attacker:main",
        runId: "run-shared-scope",
        task: "Attacker CLI task",
        status: "running",
        deliveryStatus: "not_applicable",
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

      expect(getTaskById(attackerTask.taskId)).toMatchObject({
        status: "failed",
        error: "attacker controlled error",
      });
      expect(getTaskById(victimTask.taskId)).toMatchObject({
        status: "running",
      });
      expect(getTaskById(victimTask.taskId)).not.toHaveProperty("error");
    });
  });

  it("suppresses duplicate ACP delivery when a preferred spawned task shares the runId", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      const directTask = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-shared-delivery",
        task: "Direct ACP child",
        status: "succeeded",
        deliveryStatus: "pending",
      });
      const spawnedTask = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-shared-delivery",
        task: "Spawn ACP child",
        preferMetadata: true,
        status: "succeeded",
        deliveryStatus: "pending",
      });

      await maybeDeliverTaskTerminalUpdate(directTask.taskId);
      await maybeDeliverTaskTerminalUpdate(spawnedTask.taskId);

      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
      expect(listTaskRecords().filter((task) => task.runId === "run-shared-delivery")).toHaveLength(
        1,
      );
      expect(findTaskByRunId("run-shared-delivery")).toMatchObject({
        taskId: directTask.taskId,
        task: "Spawn ACP child",
        deliveryStatus: "delivered",
      });
    });
  });

  it("does not suppress ACP delivery across different requester scopes when runIds collide", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const victimTask = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:victim:main",
        scopeKind: "session",
        childSessionKey: "agent:victim:acp:child",
        runId: "run-cross-requester-delivery",
        task: "Victim ACP task",
        status: "running",
        deliveryStatus: "pending",
      });
      const attackerTask = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:attacker:main",
        scopeKind: "session",
        childSessionKey: "agent:attacker:acp:child",
        runId: "run-cross-requester-delivery",
        task: "Attacker ACP task",
        status: "running",
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
        expect(getTaskById(victimTask.taskId)).toMatchObject({
          deliveryStatus: "session_queued",
        }),
      );
      await waitForAssertion(() =>
        expect(getTaskById(attackerTask.taskId)).toMatchObject({
          deliveryStatus: "session_queued",
        }),
      );
    });
  });

  it("adopts preferred ACP spawn metadata when collapsing onto an earlier direct record", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const directTask = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse-preferred",
        task: "Direct ACP child",
        status: "running",
        deliveryStatus: "pending",
      });

      const spawnedTask = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse-preferred",
        label: "Quant patch",
        task: "Implement the feature and report back",
        preferMetadata: true,
        status: "running",
        deliveryStatus: "pending",
      });

      expect(spawnedTask.taskId).toBe(directTask.taskId);
      expect(findTaskByRunId("run-collapse-preferred")).toMatchObject({
        taskId: directTask.taskId,
        label: "Quant patch",
        task: "Implement the feature and report back",
      });
    });
  });

  it("collapses ACP run-owned task creation onto the existing spawned task", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const spawnedTask = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse",
        task: "Spawn ACP child",
        status: "running",
        deliveryStatus: "pending",
      });

      const directTask = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-collapse",
        task: "Direct ACP child",
        status: "running",
      });

      expect(directTask.taskId).toBe(spawnedTask.taskId);
      expect(listTaskRecords().filter((task) => task.runId === "run-collapse")).toHaveLength(1);
      expect(findTaskByRunId("run-collapse")).toMatchObject({
        task: "Spawn ACP child",
      });
    });
  });

  it("delivers a terminal ACP update only once when multiple notifiers race", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "notifychat",
        to: "notifychat:123",
        via: "direct",
      });

      const task = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:acp:child",
        runId: "run-racing-delivery",
        task: "Investigate issue",
        status: "succeeded",
        deliveryStatus: "pending",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      const first = maybeDeliverTaskTerminalUpdate(task.taskId);
      const second = maybeDeliverTaskTerminalUpdate(task.taskId);
      await Promise.all([first, second]);

      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `task-terminal:${task.taskId}:succeeded:blocked`,
          mirror: expect.objectContaining({
            idempotencyKey: `task-terminal:${task.taskId}:succeeded:blocked`,
          }),
        }),
      );
      expect(findTaskByRunId("run-racing-delivery")).toMatchObject({
        deliveryStatus: "delivered",
      });
    });
  });

  it("restores persisted tasks from disk on the next lookup", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:child",
        runId: "run-restore",
        task: "Restore me",
        status: "running",
        deliveryStatus: "pending",
      });

      resetTaskRegistryForTests({
        persist: false,
      });

      expect(resolveTaskForLookupToken(task.taskId)).toMatchObject({
        taskId: task.taskId,
        runId: "run-restore",
        task: "Restore me",
      });
    });
  });

  it("indexes tasks by session key for latest and list lookups", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(1_700_000_000_000);

      const older = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:child-1",
        runId: "run-session-lookup-1",
        task: "Older task",
      });
      const latest = createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:child-2",
        runId: "run-session-lookup-2",
        task: "Latest task",
      });
      nowSpy.mockRestore();

      expect(findLatestTaskForOwnerKey("agent:main:main")?.taskId).toBe(latest.taskId);
      expect(listTasksForOwnerKey("agent:main:main").map((task) => task.taskId)).toEqual([
        latest.taskId,
        older.taskId,
      ]);
      expect(findLatestTaskForRelatedSessionKey("agent:main:subagent:child-1")?.taskId).toBe(
        older.taskId,
      );
    });
  });

  it("projects inspection-time orphaned tasks as lost without mutating the registry", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:acp:missing",
        runId: "run-lost",
        task: "Missing child",
        status: "running",
        deliveryStatus: "pending",
      });
      setTaskTimingById({
        taskId: task.taskId,
        lastEventAt: Date.now() - 10 * 60_000,
      });

      const tasks = reconcileInspectableTasks();
      expect(tasks[0]).toMatchObject({
        runId: "run-lost",
        status: "lost",
        error: "backing session missing",
      });
      expect(getTaskById(task.taskId)).toMatchObject({
        status: "running",
      });
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("marks orphaned tasks lost with cleanupAfter in a single maintenance pass", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();

      const task = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:acp:missing",
        runId: "run-lost-maintenance",
        task: "Missing child",
        status: "running",
        deliveryStatus: "pending",
      });
      setTaskTimingById({
        taskId: task.taskId,
        lastEventAt: now - 10 * 60_000,
      });

      expect(await runTaskRegistryMaintenance()).toEqual({
        reconciled: 1,
        recovered: 0,
        cleanupStamped: 0,
        pruned: 0,
      });
      expect(getTaskById(task.taskId)).toMatchObject({
        status: "lost",
        error: "backing session missing",
      });
      expect(getTaskById(task.taskId)?.cleanupAfter).toBeGreaterThan(now);
      expect(getInspectableTaskAuditSummary()).toMatchObject({
        errors: 0,
        warnings: 1,
        byCode: expect.objectContaining({
          lost: 1,
        }),
      });
    });
  });

  it("prunes old terminal tasks during maintenance sweeps", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:main",
        runId: "run-prune",
        task: "Old completed task",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        startedAt: Date.now() - 9 * 24 * 60 * 60_000,
      });
      setTaskTimingById({
        taskId: task.taskId,
        endedAt: Date.now() - 8 * 24 * 60 * 60_000,
        lastEventAt: Date.now() - 8 * 24 * 60 * 60_000,
      });

      expect(await sweepTaskRegistry()).toEqual({
        reconciled: 0,
        recovered: 0,
        cleanupStamped: 0,
        pruned: 1,
      });
      expect(listTaskRecords()).toEqual([]);
    });
  });

  it("previews and repairs missing cleanup timestamps during maintenance", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            tasks: new Map([
              [
                "task-missing-cleanup",
                {
                  taskId: "task-missing-cleanup",
                  runtime: "cron",
                  requesterSessionKey: "",
                  ownerKey: "system:cron:task-missing-cleanup",
                  scopeKind: "system",
                  runId: "run-maintenance-cleanup",
                  task: "Finished cron",
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
    await withTaskRegistryTempDir(async (root) => {
      vi.useFakeTimers();
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();

      const task = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:acp:missing",
        runId: "run-deferred-maintenance-stop",
        task: "Missing child",
        status: "running",
        deliveryStatus: "pending",
      });
      setTaskTimingById({
        taskId: task.taskId,
        lastEventAt: now - 10 * 60_000,
      });

      startTaskRegistryMaintenance();
      stopTaskRegistryMaintenanceForTests();

      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsyncWork();

      expect(getTaskById(task.taskId)).toMatchObject({
        status: "running",
      });
    });
  });

  it("does not leak unhandled rejections when the scheduled maintenance sweep fails", async () => {
    await withTaskRegistryTempDir(async (root) => {
      vi.useFakeTimers();
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      setTaskRegistryMaintenanceRuntimeForTests({
        readAcpSessionEntry: () => ({
          cfg: {} as never,
          storePath: "",
          sessionKey: "",
          storeSessionKey: "",
          entry: undefined,
          storeReadFailed: false,
        }),
        loadSessionStore: () => ({}),
        resolveStorePath: () => "",
        parseAgentSessionKey: () => null,
        isCronJobActive: () => false,
        getAgentRunContext: () => undefined,
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
        isCronRuntimeAuthoritative: () => true,
        resolveCronStorePath: () => "/tmp/openclaw-test-cron/jobs.json",
        loadCronStoreSync: () => ({ version: 1, jobs: [] }),
        resolveCronRunLogPath: ({ jobId }) => jobId,
        readCronRunLogEntriesSync: () => [],
      });

      try {
        startTaskRegistryMaintenance();
        await vi.advanceTimersByTimeAsync(5_000);
        await flushAsyncWork();
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    });
  });

  it("rechecks current task state before marking a task lost", async () => {
    const now = Date.now();
    const snapshotTask = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:acp:missing-stale",
      runId: "run-lost-stale",
      task: "Missing child",
      status: "running",
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
    expect(currentTasks.get(snapshotTask.taskId)).toMatchObject({
      status: "running",
      lastEventAt: now,
    });
  });

  it("rechecks current task state before pruning a task", async () => {
    const now = Date.now();
    const snapshotTask = createTaskRecord({
      runtime: "cli",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:main",
      runId: "run-prune-stale",
      task: "Old completed task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
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
    expect(currentTasks.get(snapshotTask.taskId)).toMatchObject({
      status: "succeeded",
      cleanupAfter: now + 60_000,
    });
  });

  it("backdates createdAt when a task is created with an earlier startedAt", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

      const task = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-backdated-create",
        task: "Backdated create",
        status: "running",
        deliveryStatus: "pending",
        startedAt: 1_699_999_999_000,
      });

      nowSpy.mockRestore();

      expect(task).toMatchObject({
        createdAt: 1_699_999_999_000,
        startedAt: 1_699_999_999_000,
        lastEventAt: 1_699_999_999_000,
      });
      expect(getInspectableTaskAuditSummary().byCode.inconsistent_timestamps).toBe(0);
    });
  });

  it("keeps timestamps monotonic when an update supplies an earlier startedAt", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

      const task = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-backdated-update",
        task: "Backdated update",
        status: "queued",
        deliveryStatus: "pending",
      });

      nowSpy.mockReturnValue(1_700_000_001_000);
      setTaskTimingById({
        taskId: task.taskId,
        startedAt: 1_699_999_998_000,
        lastEventAt: 1_699_999_998_500,
      });
      nowSpy.mockRestore();

      expect(getTaskById(task.taskId)).toMatchObject({
        createdAt: 1_699_999_998_000,
        startedAt: 1_699_999_998_000,
        lastEventAt: 1_699_999_998_500,
      });
      expect(getInspectableTaskAuditSummary().byCode.inconsistent_timestamps).toBe(0);
    });
  });

  it("normalizes restored task timestamps before exposing them", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
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

      expect(findTaskByRunId("run-restored-bad-timestamps")).toMatchObject({
        createdAt: 100,
        startedAt: 100,
        lastEventAt: 150,
      });
    });
  });

  it("reloads from durable state instead of preserving stale in-memory tasks", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();
      let durableTasks = new Map<string, ReturnType<typeof createTaskRecord>>();
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

      const staleTask = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterSessionKey: "agent:main:main",
        runId: "run-stale-memory",
        task: "Stale in-memory task",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "silent",
      });
      setTaskTimingById({
        taskId: staleTask.taskId,
        startedAt: now - 60_000,
        lastEventAt: now - 60_000,
      });
      expect(getTaskRegistrySummary().active).toBe(1);

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
      expect(findTaskByRunId("run-durable")).toMatchObject({
        taskId: "task-durable",
        status: "cancelled",
      });
      expect(getTaskRegistrySummary().active).toBe(0);
    });
  });

  it("summarizes inspectable task audit findings", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
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
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "guildchat",
        to: "guildchat:123",
        via: "direct",
      });

      const task = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "guildchat",
          to: "guildchat:123",
        },
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
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Background task update: ACP background task. No output for 60s. It may be waiting for input.",
          }),
        ),
      );
      expect(findTaskByRunId("run-state-change")).toMatchObject({
        notifyPolicy: "state_changes",
      });
      await maybeDeliverTaskStateChangeUpdate(task.taskId);
      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps background ACP progress off the foreground lane and only sends a terminal notify", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "guildchat",
        to: "guildchat:123",
        via: "direct",
      });
      vi.useFakeTimers();

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "guildchat",
          to: "guildchat:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-quiet-terminal",
        task: "Create the file",
        status: "running",
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

      expect(peekSystemEvents("agent:main:main")).toEqual([]);
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

      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "guildchat",
          to: "guildchat:123",
          content: "Background task done: ACP background task (run run-quie).",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      relay.dispose();
      vi.useRealTimers();
    });
  });

  it("delivers a concise terminal failure message without internal ACP chatter", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "guildchat",
        to: "guildchat:123",
        via: "direct",
      });

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "guildchat",
          to: "guildchat:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-failure-terminal",
        task: "Write the file",
        status: "running",
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

      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "guildchat",
          to: "guildchat:123",
          content:
            "Background task failed: ACP background task (run run-fail). Permission denied by ACP runtime",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("emits concise state-change updates without surfacing raw ACP chatter", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "guildchat",
        to: "guildchat:123",
        via: "direct",
      });
      vi.useFakeTimers();

      createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "guildchat",
          to: "guildchat:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-state-stream",
        task: "Create the file",
        status: "running",
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
      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Background task update: ACP background task. Started.",
        }),
      );

      hoisted.sendMessageMock.mockClear();
      vi.advanceTimersByTime(1_500);
      await flushAsyncWork();
      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            "Background task update: ACP background task. No output for 1s. It may be waiting for input.",
        }),
      );

      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      relay.dispose();
      vi.useRealTimers();
    });
  });

  it("cancels ACP-backed tasks through the ACP session manager", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const task = createTaskRecord({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-cancel-acp",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
      });

      const result = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(hoisted.cancelSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: {},
          sessionKey: "agent:codex:acp:child",
          reason: "task-cancel",
        }),
      );
      expect(result).toMatchObject({
        found: true,
        cancelled: true,
        task: expect.objectContaining({
          taskId: task.taskId,
          status: "cancelled",
          error: "Cancelled by operator.",
        }),
      });
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "notifychat",
            to: "notifychat:123",
            content: "Background task cancelled: ACP background task (run run-canc).",
          }),
        ),
      );
    });
  });

  it("cancels subagent-backed tasks through subagent control", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      hoisted.killSubagentRunAdminMock.mockResolvedValue({
        found: true,
        killed: true,
      });

      const task = createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:worker:subagent:child",
        runId: "run-cancel-subagent",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
      });

      const result = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(hoisted.killSubagentRunAdminMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: {},
          sessionKey: "agent:worker:subagent:child",
        }),
      );
      expect(result).toMatchObject({
        found: true,
        cancelled: true,
        task: expect.objectContaining({
          taskId: task.taskId,
          status: "cancelled",
          error: "Cancelled by operator.",
        }),
      });
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "notifychat",
            to: "notifychat:123",
            content: "Background task cancelled: Subagent task (run run-canc).",
          }),
        ),
      );
    });
  });

  it("cancels CLI-tracked tasks in the registry without ACP or subagent teardown", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      hoisted.cancelSessionMock.mockClear();
      hoisted.killSubagentRunAdminMock.mockClear();

      const task = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        childSessionKey: "agent:main:main",
        runId: "run-cancel-cli",
        task: "Investigate issue",
        status: "running",
        deliveryStatus: "pending",
      });

      const result = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(hoisted.cancelSessionMock).not.toHaveBeenCalled();
      expect(hoisted.killSubagentRunAdminMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        found: true,
        cancelled: true,
        task: expect.objectContaining({
          taskId: task.taskId,
          status: "cancelled",
          error: "Cancelled by operator.",
        }),
      });
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "notifychat",
            to: "notifychat:123",
            content: "Background task cancelled: Investigate issue (run run-canc).",
          }),
        ),
      );
    });
  });

  it("cancels CLI-tracked tasks without childSessionKey", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      const task = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "notifychat",
          to: "notifychat:123",
        },
        runId: "run-cli-no-child",
        task: "Legacy row",
        status: "running",
        deliveryStatus: "pending",
      });

      const result = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(result).toMatchObject({
        found: true,
        cancelled: true,
        task: expect.objectContaining({
          taskId: task.taskId,
          status: "cancelled",
        }),
      });
    });
  });
});
