import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions.js";
import type { CronRunLogEntry } from "../cron/run-log.js";
import type { CronStoreFile } from "../cron/types.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
  getDetachedTaskLifecycleRuntime,
} from "./detached-task-runtime.js";
import {
  previewTaskRegistryMaintenance,
  reconcileInspectableTasks,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenanceForTests,
} from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";

const GRACE_EXPIRED_MS = 10 * 60_000;

function makeStaleTask(overrides: Partial<TaskRecord>): TaskRecord {
  const now = Date.now();
  return {
    taskId: "task-test-" + Math.random().toString(36).slice(2),
    runtime: "cron",
    requesterSessionKey: "agent:main:main",
    ownerKey: "system:cron:test",
    scopeKind: "system",
    task: "test task",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: now - GRACE_EXPIRED_MS,
    startedAt: now - GRACE_EXPIRED_MS,
    lastEventAt: now - GRACE_EXPIRED_MS,
    ...overrides,
  };
}

type TaskRegistryMaintenanceRuntime = Parameters<
  typeof setTaskRegistryMaintenanceRuntimeForTests
>[0];

afterEach(() => {
  stopTaskRegistryMaintenanceForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetDetachedTaskLifecycleRuntimeForTests();
});

function createTaskRegistryMaintenanceHarness(params: {
  tasks: TaskRecord[];
  sessionStore?: Record<string, SessionEntry>;
  acpEntry?: AcpSessionStoreEntry["entry"];
  activeCronJobIds?: string[];
  activeRunIds?: string[];
  cronStore?: CronStoreFile;
  cronRunLogEntries?: Record<string, CronRunLogEntry[]>;
  cronRuntimeAuthoritative?: boolean;
}) {
  const sessionStore = params.sessionStore ?? {};
  const acpEntry = params.acpEntry;
  const activeCronJobIds = new Set(params.activeCronJobIds ?? []);
  const activeRunIds = new Set(params.activeRunIds ?? []);
  const cronRunLogEntries = params.cronRunLogEntries ?? {};
  const currentTasks = new Map(params.tasks.map((task) => [task.taskId, { ...task }]));

  const runtime: TaskRegistryMaintenanceRuntime = {
    listAcpSessionEntries: async () => [],
    readAcpSessionEntry: () =>
      acpEntry !== undefined
        ? ({
            cfg: {} as never,
            storePath: "",
            sessionKey: "",
            storeSessionKey: "",
            entry: acpEntry,
            storeReadFailed: false,
          } satisfies AcpSessionStoreEntry)
        : ({
            cfg: {} as never,
            storePath: "",
            sessionKey: "",
            storeSessionKey: "",
            entry: undefined,
            storeReadFailed: false,
          } satisfies AcpSessionStoreEntry),
    loadSessionStore: () => sessionStore,
    resolveStorePath: () => "",
    isCronJobActive: (jobId: string) => activeCronJobIds.has(jobId),
    getAgentRunContext: (runId: string) =>
      activeRunIds.has(runId) ? { sessionKey: "main" } : undefined,
    parseAgentSessionKey: (sessionKey: string | null | undefined): ParsedAgentSessionKey | null => {
      if (!sessionKey) {
        return null;
      }
      const [kind, agentId, ...rest] = sessionKey.split(":");
      return kind === "agent" && agentId && rest.length > 0
        ? { agentId, rest: rest.join(":") }
        : null;
    },
    deleteTaskRecordById: (taskId: string) => currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => currentTasks.get(taskId),
    listTaskRecords: () => Array.from(currentTasks.values()),
    markTaskLostById: (patch) => {
      const current = currentTasks.get(patch.taskId);
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
      currentTasks.set(patch.taskId, next);
      return next;
    },
    markTaskTerminalById: (patch) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        status: patch.status,
        endedAt: patch.endedAt,
        lastEventAt: patch.lastEventAt ?? patch.endedAt,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.terminalSummary !== undefined
          ? { terminalSummary: patch.terminalSummary ?? undefined }
          : {}),
      } satisfies TaskRecord;
      currentTasks.set(patch.taskId, next);
      return next;
    },
    maybeDeliverTaskTerminalUpdate: async () => null,
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: (patch) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = { ...current, cleanupAfter: patch.cleanupAfter };
      currentTasks.set(patch.taskId, next);
      return next;
    },
    isCronRuntimeAuthoritative: () => params.cronRuntimeAuthoritative ?? true,
    resolveCronStorePath: () => "/tmp/openclaw-test-cron/jobs.json",
    loadCronStoreSync: () => params.cronStore ?? { version: 1, jobs: [] },
    resolveCronRunLogPath: ({ jobId }) => jobId,
    readCronRunLogEntriesSync: (jobId) => cronRunLogEntries[jobId] ?? [],
  };

  setTaskRegistryMaintenanceRuntimeForTests(runtime);
  return { currentTasks };
}

describe("task-registry maintenance issue #60299", () => {
  it("marks stale cron tasks lost once the runtime no longer tracks the job as active", async () => {
    const childSessionKey = "agent:main:workspace:channel:test-channel";
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-1",
      childSessionKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [childSessionKey]: { sessionId: childSessionKey, updatedAt: Date.now() } },
    });

    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("keeps active cron tasks live while the cron runtime still owns the job", async () => {
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-2",
      childSessionKey: undefined,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      activeCronJobIds: ["cron-job-2"],
    });

    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });

  it("marks subagent tasks lost when their child session recovery is tombstoned", async () => {
    const childSessionKey = "agent:main:subagent:wedged-child";
    const task = makeStaleTask({
      runtime: "subagent",
      runId: "run-wedged-child",
      childSessionKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: {
        [childSessionKey]: {
          sessionId: "session-wedged-child",
          updatedAt: Date.now(),
          abortedLastRun: false,
          subagentRecovery: {
            automaticAttempts: 2,
            lastAttemptAt: Date.now() - 30_000,
            lastRunId: "run-wedged-child",
            wedgedAt: Date.now() - 20_000,
            wedgedReason: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
          },
        },
      },
    });

    expect(previewTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({
      status: "lost",
      error: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
    });
  });

  it("does not mark cron tasks lost when the current process is not the cron runtime authority", async () => {
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-offline-audit",
      childSessionKey: undefined,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      cronRuntimeAuthoritative: false,
    });

    expect(previewTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });

  it("recovers finished cron tasks from durable run logs before marking them lost", async () => {
    const startedAt = Date.now() - GRACE_EXPIRED_MS;
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-run-log-ok",
      runId: `cron:cron-job-run-log-ok:${startedAt}`,
      startedAt,
      lastEventAt: startedAt,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      cronRunLogEntries: {
        "cron-job-run-log-ok": [
          {
            ts: startedAt + 1250,
            jobId: "cron-job-run-log-ok",
            action: "finished",
            status: "ok",
            summary: "done",
            runAtMs: startedAt,
            durationMs: 1250,
          },
        ],
      },
    });

    expect(reconcileInspectableTasks()).toEqual([
      expect.objectContaining({
        taskId: task.taskId,
        status: "succeeded",
        endedAt: startedAt + 1250,
        terminalSummary: "done",
      }),
    ]);
    expect(previewTaskRegistryMaintenance()).toMatchObject({ reconciled: 0, recovered: 1 });
    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0, recovered: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({
      status: "succeeded",
      endedAt: startedAt + 1250,
      terminalSummary: "done",
    });
  });

  it("recovers interrupted cron tasks from durable cron job state when run logs are absent", async () => {
    const startedAt = Date.now() - GRACE_EXPIRED_MS;
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-state-error",
      runId: `cron:cron-job-state-error:${startedAt}`,
      startedAt,
      lastEventAt: startedAt,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      cronStore: {
        version: 1,
        jobs: [
          {
            id: "cron-job-state-error",
            name: "state error",
            enabled: true,
            createdAtMs: startedAt - 60_000,
            updatedAtMs: startedAt,
            schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt - 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "work" },
            state: {
              lastRunAtMs: startedAt,
              lastRunStatus: "error",
              lastError: "cron: job interrupted by gateway restart",
              lastDurationMs: 5000,
            },
          },
        ],
      },
    });

    expect(previewTaskRegistryMaintenance()).toMatchObject({ reconciled: 0, recovered: 1 });
    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0, recovered: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({
      status: "failed",
      endedAt: startedAt + 5000,
      error: "cron: job interrupted by gateway restart",
    });
  });

  it("marks chat-backed cli tasks lost after the owning run context disappears", async () => {
    const channelKey = "agent:main:workspace:channel:C1234567890";
    const task = makeStaleTask({
      runtime: "cli",
      sourceId: "run-chat-cli-stale",
      runId: "run-chat-cli-stale",
      ownerKey: "agent:main:main",
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [channelKey]: { sessionId: channelKey, updatedAt: Date.now() } },
    });

    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("keeps chat-backed cli tasks live while the owning run context is still active", async () => {
    const channelKey = "agent:main:workspace:channel:C1234567890";
    const task = makeStaleTask({
      runtime: "cli",
      sourceId: "run-chat-cli-live",
      runId: "run-chat-cli-live",
      ownerKey: "agent:main:main",
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [channelKey]: { sessionId: channelKey, updatedAt: Date.now() } },
      activeRunIds: ["run-chat-cli-live"],
    });

    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });

  it("keeps detached media cli tasks live while their tool run context is active", async () => {
    const channelKey = "agent:main:discord:channel:1456744319972282449";
    const runId = "tool:video_generate:ac88dfc5-c2a9-4630-ab48-384e6450a12b";
    const task = makeStaleTask({
      runtime: "cli",
      taskKind: "video_generation",
      sourceId: "video_generate:fal",
      runId,
      ownerKey: channelKey,
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
      progressSummary: "Generating video",
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [channelKey]: { sessionId: channelKey, updatedAt: Date.now() } },
      activeRunIds: [runId],
    });

    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });

  it("keeps recently refreshed media cli tasks live without a chat run context", async () => {
    const channelKey = "agent:main:discord:channel:1456744319972282449";
    const task = makeStaleTask({
      runtime: "cli",
      taskKind: "video_generation",
      sourceId: "video_generate:fal",
      runId: "tool:video_generate:3a948fb2-79e8-470c-a6bc-46f37732cd3d",
      ownerKey: channelKey,
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
      lastEventAt: Date.now() - 60_000,
      progressSummary: "Generating video",
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [channelKey]: { sessionId: channelKey, updatedAt: Date.now() } },
    });

    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });

  it("skips markTaskLost and counts recovered when recovery hook recovers a stale task", async () => {
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-recovered",
      childSessionKey: undefined,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
    });

    const recoveryHook = vi.fn(() => ({ recovered: true }));
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      tryRecoverTaskBeforeMarkLost: recoveryHook,
    });

    expect(previewTaskRegistryMaintenance()).toMatchObject({ reconciled: 1, recovered: 0 });
    const result = await runTaskRegistryMaintenance();
    expect(result).toMatchObject({ reconciled: 0, recovered: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
    expect(recoveryHook).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.taskId,
        runtime: "cron",
        task: expect.objectContaining({ taskId: task.taskId }),
        now: expect.any(Number),
      }),
    );
  });
});
