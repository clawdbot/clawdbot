// Tasks command tests cover task listing, status rendering, cron-store integration, and cancellations.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { saveCronStore } from "../cron/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createManagedTaskFlow as createManagedTaskFlowOrNull } from "../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  getTaskById,
  markTaskLostById,
  markTaskTerminalById,
  reloadTaskRegistryFromStore,
} from "../tasks/task-registry.js";
import * as taskRegistryMaintenance from "../tasks/task-registry.maintenance.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import type {
  TaskSystemAuditCode,
  TaskSystemAuditSeverity,
} from "../tasks/task-system-audit.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  tasksAuditCommand,
  tasksCancelCommand,
  tasksListCommand,
  tasksMaintenanceCommand,
  tasksShowCommand,
} from "./tasks.js";

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
  } as unknown as RuntimeEnv;
}

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function readFirstJsonLog(runtime: RuntimeEnv): unknown {
  const calls = vi.mocked(runtime.log).mock.calls;
  const [message] = calls[0] ?? [];
  return JSON.parse(String(message));
}

function jsonRoundTrip<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

const UNSAFE_TASK_TERMINAL_TEXT = "\u001b]52;c;Zm9yZ2Vk\u0007\nforged: yes";

function createInspectableTask(params: Partial<Parameters<typeof createTaskRecord>[0]> = {}) {
  return createTaskRecord({
    runtime: "cli",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    status: "running",
    notifyPolicy: "silent",
    task: "Inspect a background task",
    ...params,
  });
}

function expectSafeTaskOutput(runtime: RuntimeEnv, channel: "log" | "error" = "log") {
  for (const [line] of vi.mocked(runtime[channel]).mock.calls) {
    for (const control of ["\u001b", "\u0007", "\n", "\r"]) {
      expect(String(line)).not.toContain(control);
    }
  }
}

const zeroTaskAuditCounts = {
  delivery_failed: 0,
  inconsistent_timestamps: 0,
  lost: 0,
  missing_cleanup: 0,
  stale_queued: 0,
  stale_running: 0,
};

async function writeSessionEntries(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  }
}

function resetTaskCommandRuntime() {
  taskRegistryMaintenance.stopTaskRegistryMaintenance();
  taskRegistryMaintenance.resetTaskRegistryMaintenanceRuntimeForTests();
  resetConfigRuntimeState();
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  closeOpenClawAgentDatabasesForTest();
}

async function withTaskCommandStateDir(
  run: (state: OpenClawTestState) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-tasks-command-" },
    async (state) => {
      resetTaskCommandRuntime();
      try {
        await run(state);
      } finally {
        resetTaskCommandRuntime();
      }
    },
  );
}

describe("tasks commands", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTaskCommandRuntime();
    mocks.callGateway.mockReset();
  });

  it("keeps audit JSON stable and sorts combined findings before limiting", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-stale-queued",
        status: "running",
        task: "Inspect issue backlog",
        startedAt: now - 40 * 60_000,
      });
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Inspect issue backlog",
        status: "waiting",
        createdAt: now - 40 * 60_000,
        updatedAt: now - 40 * 60_000,
      });

      const runtime = createRuntime();
      await tasksAuditCommand({ json: true }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        summary: {
          total: number;
          errors: number;
          warnings: number;
          byCode: Record<string, number>;
          taskFlows: { total: number; byCode: Record<string, number> };
          combined: { total: number; errors: number; warnings: number };
        };
      };

      expect(payload.summary.byCode.lost).toBe(1);
      expect(payload.summary.taskFlows.byCode.stale_waiting).toBe(1);
      expect(payload.summary.taskFlows.byCode.missing_linked_tasks).toBe(1);
      expect(payload.summary.combined.total).toBe(3);

      const runningFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Running flow",
        status: "running",
        createdAt: now - 45 * 60_000,
        updatedAt: now - 45 * 60_000,
      });

      const limitedRuntime = createRuntime();
      const auditStartedAt = Date.now();
      await tasksAuditCommand({ json: true, limit: 1 }, limitedRuntime);
      const auditFinishedAt = Date.now();

      const limitedPayload = readFirstJsonLog(limitedRuntime) as { findings: unknown[] };
      const [limitedFinding] = limitedPayload.findings as Array<{ ageMs?: number }>;

      expect(limitedPayload.findings).toHaveLength(1);
      expect(limitedFinding).toMatchObject({
        kind: "task_flow",
        severity: "error",
        code: "stale_running",
        detail: "running TaskFlow has not advanced recently",
        status: "running",
        token: runningFlow.flowId,
        flow: jsonRoundTrip(runningFlow),
      });
      expect(limitedFinding?.ageMs).toBeGreaterThanOrEqual(auditStartedAt - runningFlow.updatedAt);
      expect(limitedFinding?.ageMs).toBeLessThanOrEqual(auditFinishedAt - runningFlow.updatedAt);
    });
  });

  it("keeps task-flow restore failures inspectable in full audit output", async () => {
    await withTaskCommandStateDir(async () => {
      const loadSnapshot = vi.fn(() => {
        throw new Error("SQLITE_IOERR: task-flow command audit restore failed");
      });
      configureTaskFlowRegistryRuntime({
        store: {
          loadSnapshot,
          saveSnapshot: () => {},
        },
      });

      const jsonRuntime = createRuntime();
      await tasksAuditCommand({ json: true }, jsonRuntime);
      expect(readFirstJsonLog(jsonRuntime)).toMatchObject({
        count: 1,
        summary: {
          taskFlows: {
            total: 1,
            errors: 1,
            byCode: {
              restore_failed: 1,
            },
          },
        },
        findings: [
          {
            kind: "task_flow",
            severity: "error",
            code: "restore_failed",
            detail:
              "task-flow registry restore failed: SQLITE_IOERR: task-flow command audit restore failed",
          },
        ],
      });

      const textRuntime = createRuntime();
      await tasksAuditCommand({ json: false }, textRuntime);
      const output = vi
        .mocked(textRuntime.log)
        .mock.calls.map(([line]) => String(line))
        .join("\n");
      expect(output).toContain("TaskFlow");
      expect(output).toContain("restore_failed");
      expect(output).toContain("task-flow registry restore failed");
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  it("reports blank list filters as absent in command JSON output", async () => {
    await withTaskCommandStateDir(async () => {
      const task = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-cli",
        status: "running",
        task: "Inspect issue backlog",
      });

      const runtime = createRuntime();
      await tasksListCommand({ json: true, runtime: "   ", status: "\t" }, runtime);

      expect(readFirstJsonLog(runtime)).toStrictEqual({
        count: 1,
        runtime: null,
        status: null,
        tasks: [jsonRoundTrip(task)],
      });
    });
  });

  it("reports blank audit filters as absent in command JSON output", async () => {
    await withTaskCommandStateDir(async () => {
      const runtime = createRuntime();
      await tasksAuditCommand(
        {
          json: true,
          severity: "  " as TaskSystemAuditSeverity,
          code: "\t" as TaskSystemAuditCode,
        },
        runtime,
      );

      expect(readFirstJsonLog(runtime)).toMatchObject({
        filters: {
          severity: null,
          code: null,
        },
      });
    });
  });

  it.each([
    {
      label: "Cron",
      runtime: "cron",
      ownerKey: "",
      scopeKind: "system",
      childSessionKey: "agent:main:cron:nightly-gmail-sync",
      runId: "cron:nightly-gmail-sync:123",
    },
    {
      label: "ACP",
      runtime: "acp",
      ownerKey: "agent:jarvis:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:child",
      runId: "run-acp-cancel",
    },
    {
      label: "Subagent",
      runtime: "subagent",
      ownerKey: "agent:jarvis:main",
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      runId: "run-subagent-cancel",
    },
  ] as const)("routes $label task cancellation through the live gateway", async (testCase) => {
    await withTaskCommandStateDir(async () => {
      const task = createTaskRecord({
        runtime: testCase.runtime,
        ownerKey: testCase.ownerKey,
        scopeKind: testCase.scopeKind,
        childSessionKey: testCase.childSessionKey,
        runId: testCase.runId,
        task: `Cancel ${testCase.label} child`,
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
      });
      mocks.callGateway.mockResolvedValueOnce({
        found: true,
        cancelled: true,
        task: {
          taskId: task.taskId,
          runtime: testCase.runtime,
          runId: task.runId,
        },
      });
      const runtime = createRuntime();

      await tasksCancelCommand({ lookup: task.taskId }, runtime);

      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "tasks.cancel",
          params: { taskId: task.taskId },
          timeoutMs: 5_000,
        }),
      );
      expect(runtime.log).toHaveBeenCalledWith(
        `Cancelled ${task.taskId} (${testCase.runtime}) run ${testCase.runId}.`,
      );
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    });
  });

  it.each(["gateway", "local"] as const)(
    "sanitizes untrusted %s task cancellation output",
    async (owner) => {
      await withTaskCommandStateDir(async () => {
        const unsafe = UNSAFE_TASK_TERMINAL_TEXT;
        const gatewayOwned = owner === "gateway";
        const task = createInspectableTask({
          runtime: gatewayOwned ? "cron" : "cli",
          ownerKey: gatewayOwned ? "" : "agent:main:main",
          scopeKind: gatewayOwned ? "system" : "session",
          runId: `run${unsafe}`,
        });
        if (gatewayOwned) {
          mocks.callGateway.mockResolvedValueOnce({
            found: true,
            cancelled: true,
            task: {
              taskId: `${task.taskId}${unsafe}`,
              runtime: `cron${unsafe}`,
              runId: task.runId,
            },
          });
        }
        const runtime = createRuntime();
        await tasksCancelCommand({ lookup: task.taskId }, runtime);
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining(`Cancelled ${task.taskId}`),
        );
        expectSafeTaskOutput(runtime);
        if (!gatewayOwned) {
          expect(getTaskById(task.taskId)).toMatchObject({
            status: "cancelled",
            runId: `run${unsafe}`,
          });
          return;
        }
        mocks.callGateway.mockResolvedValueOnce({
          found: true,
          cancelled: false,
          reason: `gateway refused${unsafe}`,
        });
        const failureRuntime = createRuntime();
        await tasksCancelCommand({ lookup: task.taskId }, failureRuntime);
        expectSafeTaskOutput(failureRuntime, "error");
      });
    },
  );

  it.each([
    {
      label: "ACP",
      runtime: "acp",
      childSessionKey: "agent:codex:acp:child",
      runId: "run-acp-cancel-gateway-down",
    },
    {
      label: "Subagent",
      runtime: "subagent",
      childSessionKey: "agent:worker:subagent:child",
      runId: "run-subagent-cancel-gateway-down",
    },
  ] as const)(
    "fails $label task cancellation loudly when the live gateway is unavailable",
    async (testCase) => {
      await withTaskCommandStateDir(async () => {
        const task = createTaskRecord({
          runtime: testCase.runtime,
          ownerKey: "agent:jarvis:main",
          scopeKind: "session",
          childSessionKey: testCase.childSessionKey,
          runId: testCase.runId,
          task: `Cancel ${testCase.label} child`,
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });
        mocks.callGateway.mockRejectedValueOnce(new Error("gateway unavailable"));
        const runtime = createRuntime();

        await tasksCancelCommand({ lookup: task.taskId }, runtime);

        expect(mocks.callGateway).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "tasks.cancel",
            params: { taskId: task.taskId },
            timeoutMs: 5_000,
          }),
        );
        expect(runtime.error).toHaveBeenCalledWith(
          `${testCase.runtime.toUpperCase()} task cancellation requires the live Gateway tasks.cancel path: gateway unavailable`,
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(runtime.log).not.toHaveBeenCalled();
      });
    },
  );

  it("explains stale running tasks retained by backing sessions in maintenance JSON", async () => {
    await withTaskCommandStateDir(async (state) => {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:child-retained";
      const task = createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId: "run-retained-child",
        status: "running",
        task: "Review retained child session",
        startedAt: now - 45 * 60_000,
      });

      const sessionsDir = state.sessionsDir("main");
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeSessionEntries(storePath, {
        [childSessionKey]: {
          sessionId: "child-retained",
          updatedAt: now,
        },
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: false }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        diagnostics: {
          staleRunningTasks: Array<{
            taskId: string;
            decision: string;
            reason: string;
            childSessionKey?: string;
          }>;
        };
      };

      expect(payload.diagnostics.staleRunningTasks).toContainEqual(
        expect.objectContaining({
          taskId: task.taskId,
          decision: "retained",
          reason: "backing_session_present",
          childSessionKey,
        }),
      );
    });
  });

  it("explains task maintenance decisions before applying session registry pruning", async () => {
    await withTaskCommandStateDir(async (state) => {
      const now = Date.now();
      const childSessionKey = "agent:main:cron:done-job:run:old-run";
      const task = createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId: "run-backed-before-session-sweep",
        status: "running",
        task: "Review old cron child session",
        startedAt: now - 45 * 60_000,
      });

      const sessionsDir = state.sessionsDir("main");
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeSessionEntries(storePath, {
        [childSessionKey]: {
          sessionId: "old-run",
          updatedAt: now - 8 * 24 * 60 * 60_000,
        },
        "agent:main:telegram:dm:recent": {
          sessionId: "recent-session",
          updatedAt: now - 60_000,
        },
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: true }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        maintenance: {
          tasks: { reconciled: number };
          sessions: { pruned: number };
        };
        diagnostics: {
          staleRunningTasks: Array<{
            taskId: string;
            decision: string;
            reason: string;
            childSessionKey?: string;
          }>;
        };
      };

      expect(payload.maintenance.tasks.reconciled).toBe(0);
      expect(payload.maintenance.sessions.pruned).toBe(1);
      expect(payload.diagnostics.staleRunningTasks).toContainEqual(
        expect.objectContaining({
          taskId: task.taskId,
          decision: "retained",
          reason: "backing_session_present",
          childSessionKey,
        }),
      );

      expect(loadSessionEntry({ sessionKey: childSessionKey, storePath })).toBeUndefined();
      expect(
        loadSessionEntry({ sessionKey: "agent:main:telegram:dm:recent", storePath }),
      ).toBeDefined();
    });
  });

  it("preserves both cron-run session key shapes for a running non-slug job id", async () => {
    await withTaskCommandStateDir(async (state) => {
      const now = Date.now();
      const old = now - 8 * 24 * 60 * 60_000;
      await saveCronStore(state.statePath("cron", "jobs.json"), {
        version: 1,
        jobs: [
          {
            id: "Daily Report",
            name: "Daily Report",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            sessionKey: "cron:daily-report",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "ping" },
            delivery: { mode: "none" },
            createdAtMs: now,
            updatedAtMs: now,
            state: { runningAtMs: now - 5_000 },
          },
        ],
      });

      const sessionsDir = state.sessionsDir("main");
      const storePath = path.join(sessionsDir, "sessions.json");
      // A running job can be retargeted after its session is created, so maintenance must preserve
      // both the raw and slugged historical shapes.
      const slugKey = "agent:main:cron:daily-report:run:old-run";
      const rawKey = "agent:main:cron:daily report:run:old-run";
      const retiredKey = "agent:main:cron:retired-job:run:old-run";
      await writeSessionEntries(storePath, {
        [slugKey]: { sessionId: "slug-run", updatedAt: old },
        [rawKey]: { sessionId: "raw-run", updatedAt: old },
        [retiredKey]: { sessionId: "retired-run", updatedAt: old },
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: true }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        maintenance: { sessions: { runningCronJobs: number } };
      };
      expect(payload.maintenance.sessions.runningCronJobs).toBe(1);
      expect(loadSessionEntry({ sessionKey: slugKey, storePath })).toBeDefined();
      expect(loadSessionEntry({ sessionKey: rawKey, storePath })).toBeDefined();
      expect(loadSessionEntry({ sessionKey: retiredKey, storePath })).toBeUndefined();
    });
  });

  it("preserves a running cron session with an explicit session key", async () => {
    await withTaskCommandStateDir(async (state) => {
      const now = Date.now();
      const old = now - 8 * 24 * 60 * 60_000;
      await saveCronStore(state.statePath("cron", "jobs.json"), {
        version: 1,
        jobs: [
          {
            id: "job-uuid",
            name: "Daily monitor",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            sessionKey: "cron:daily-monitor",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "ping" },
            delivery: { mode: "none" },
            createdAtMs: now,
            updatedAtMs: now,
            state: { runningAtMs: now - 5_000 },
          },
        ],
      });

      const sessionsDir = state.sessionsDir("main");
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeSessionEntries(storePath, {
        "agent:main:cron:daily-monitor:run:old-run": {
          sessionId: "explicit-run",
          updatedAt: old,
        },
        "agent:main:cron:job-uuid:run:old-run": {
          sessionId: "job-id-run",
          updatedAt: old,
        },
        "agent:main:cron:retired-job:run:old-run": {
          sessionId: "retired-run",
          updatedAt: old,
        },
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: true }, runtime);

      expect(
        loadSessionEntry({
          sessionKey: "agent:main:cron:daily-monitor:run:old-run",
          storePath,
        }),
      ).toBeDefined();
      expect(
        loadSessionEntry({ sessionKey: "agent:main:cron:retired-job:run:old-run", storePath }),
      ).toBeUndefined();
    });
  });

  it("does not build JSON-only diagnostics for text maintenance output", async () => {
    await withTaskCommandStateDir(async () => {
      const diagnosticsSpy = vi.spyOn(
        taskRegistryMaintenance,
        "getTaskRegistryMaintenanceDiagnostics",
      );
      const runtime = createRuntime();

      await tasksMaintenanceCommand({ json: false, apply: false }, runtime);

      expect(diagnosticsSpy).not.toHaveBeenCalled();
    });
  });

  it("shows tasks with Date-invalid optional timestamps without crashing", async () => {
    await withTaskCommandStateDir(async () => {
      const task = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-invalid-started-at",
        status: "running",
        task: "Inspect malformed task timestamp",
        startedAt: 8_700_000_000_000_000,
      });

      const runtime = createRuntime();
      await tasksShowCommand({ json: false, lookup: task.taskId }, runtime);

      const joined = vi
        .mocked(runtime.log)
        .mock.calls.map(([line]) => String(line))
        .join("\n");
      expect(joined).toContain(`taskId: ${task.taskId}`);
      expect(joined).toContain("startedAt: n/a");
    });
  });

  it("sanitizes every persisted task surface while preserving raw task JSON", async () => {
    await withTaskCommandStateDir(async () => {
      const unsafe = UNSAFE_TASK_TERMINAL_TEXT;
      const task = createInspectableTask({
        sourceId: `source${unsafe}`,
        childSessionKey: `agent:main:child${unsafe}`,
        parentTaskId: `parent${unsafe}`,
        agentId: `worker${unsafe}`,
        runId: `run${unsafe}`,
        label: `label${unsafe}`,
        task: `prompt${unsafe}`,
        progressSummary: `progress${unsafe}`,
        terminalSummary: `summary${unsafe}`,
      });
      markTaskLostById({ taskId: task.taskId, endedAt: Date.now(), error: `error${unsafe}` });
      const showRuntime = createRuntime();
      const listRuntime = createRuntime();
      const auditRuntime = createRuntime();
      await tasksShowCommand({ lookup: task.taskId }, showRuntime);
      await tasksListCommand({}, listRuntime);
      await tasksAuditCommand({}, auditRuntime);
      for (const runtime of [showRuntime, listRuntime, auditRuntime]) {
        expectSafeTaskOutput(runtime);
      }
      const shown = vi
        .mocked(showRuntime.log)
        .mock.calls.map(([line]) => String(line))
        .join("|");
      for (const field of [
        "sourceId",
        "childSessionKey",
        "parentTaskId",
        "agentId",
        "runId",
        "label",
        "task",
        "error",
        "progressSummary",
        "terminalSummary",
      ]) {
        expect(shown).toContain(`${field}:`);
      }
      expect(vi.mocked(listRuntime.log).mock.calls.flat().join("|")).toContain("error");
      expect(vi.mocked(auditRuntime.log).mock.calls.flat().join("|")).toContain("error");
      const jsonRuntime = createRuntime();
      await tasksShowCommand({ lookup: task.taskId, json: true }, jsonRuntime);
      expect(readFirstJsonLog(jsonRuntime)).toEqual(jsonRoundTrip(getTaskById(task.taskId)));
      expect(getTaskById(task.taskId)).toMatchObject({
        runId: `run${unsafe}`,
        error: `error${unsafe}`,
      });
      const lookupRuntime = createRuntime();
      await tasksShowCommand({ lookup: `missing${unsafe}` }, lookupRuntime);
      expectSafeTaskOutput(lookupRuntime, "error");

      const jsonLookupRuntime = createRuntime();
      await tasksShowCommand({ lookup: `missing${unsafe}`, json: true }, jsonLookupRuntime);
      expect(readFirstJsonLog(jsonLookupRuntime)).toMatchObject({
        ok: false,
        error: {
          type: "cli_error",
          message: expect.stringContaining("Task not found: missing"),
        },
      });
      expect(jsonLookupRuntime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
    });
  });

  it.each(["failed", "timed_out", "lost"] as const)(
    "shows the persisted failure reason for %s tasks in list summaries",
    async (status) => {
      await withTaskCommandStateDir(async () => {
        const task = createInspectableTask({
          runId: `task-list-${status}`,
          label: "Original task title",
          progressSummary: "Outdated running progress",
          terminalSummary: "Generic terminal summary",
        });
        const error = `${status}: upstream credentials need attention`;
        const terminal = { taskId: task.taskId, endedAt: Date.now(), error };
        if (status === "lost") {
          markTaskLostById(terminal);
        } else {
          markTaskTerminalById({
            ...terminal,
            status,
            terminalSummary: "Generic terminal summary",
          });
        }
        const runtime = createRuntime();
        await tasksListCommand({}, runtime);
        const output = vi.mocked(runtime.log).mock.calls.flat().join("|");
        expect(output).toContain(error);
        expect(output).not.toContain("Outdated running progress");
        expect(output).not.toContain("Generic terminal summary");
      });
    },
  );

  it("keeps task list summaries within their UTF-16 column limit", async () => {
    await withTaskCommandStateDir(async () => {
      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-utf16-summary",
        status: "succeeded",
        task: "Inspect task summary",
        terminalSummary: `${"y".repeat(78)}🚀xx`,
      });
      createInspectableTask({ progressSummary: "Fetching provider credentials" });
      createInspectableTask({ status: "succeeded", label: "Human-readable task title" });
      const runtime = createRuntime();

      await tasksListCommand({}, runtime);

      const output = vi
        .mocked(runtime.log)
        .mock.calls.map(([line]) => String(line))
        .join("\n");
      expect(output).toContain(`${"y".repeat(78)}…`);
      expect(output).not.toContain("🚀");
      expect(output).toContain("Fetching provider credentials");
      expect(output).toContain("Human-readable task title");
    });
  });

  it("explains retained lost task cleanup timing in maintenance text output", async () => {
    await withTaskCommandStateDir(async () => {
      const cleanupAfter = Date.now() + 60_000;
      createTaskRecord({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-retained-lost",
        status: "lost",
        task: "Retained lost task",
        cleanupAfter,
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: false, apply: true }, runtime);

      const joined = vi
        .mocked(runtime.log)
        .mock.calls.map(([line]) => String(line))
        .join("\n");
      expect(joined).toContain(
        `Retained lost tasks: 1 retained until ${new Date(cleanupAfter).toISOString()}; maintenance will prune after cleanupAfter.`,
      );
    });
  });

  it("keeps tasks maintenance JSON additive for TaskFlow state", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-command",
        goal: "Old terminal flow",
        status: "succeeded",
        createdAt: now - 8 * 24 * 60 * 60_000,
        updatedAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: false }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        mode: string;
        maintenance: { taskFlows: { pruned: number } };
        auditBefore: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
        };
        auditAfter: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
        };
      };

      expect(payload.mode).toBe("preview");
      expect(payload.maintenance.taskFlows.pruned).toBe(1);
      expect(payload.auditBefore.byCode).toStrictEqual(zeroTaskAuditCounts);
      expect(payload.auditBefore.taskFlows.byCode.stale_running).toBe(0);
      expect(payload.auditAfter.byCode).toStrictEqual(zeroTaskAuditCounts);
      expect(payload.auditAfter.taskFlows.byCode.stale_running).toBe(0);
    });
  });

  it.each([false, true])(
    "refuses all maintenance when task-flow restore fails (apply=%s)",
    async (apply) => {
      await withTaskCommandStateDir(async (state) => {
        const now = Date.now();
        vi.useFakeTimers();
        vi.setSystemTime(now - 8 * 24 * 60 * 60_000);
        const staleTask = createTaskRecord({
          runtime: "cli",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          runId: `stale-task-${String(apply)}`,
          task: "Task that maintenance would prune",
          status: "succeeded",
          deliveryStatus: "not_applicable",
        });
        vi.setSystemTime(now);
        const storePath = path.join(state.sessionsDir("main"), "sessions.json");
        const staleSessionKey = "agent:main:cron:done-job:run:old-run";
        await writeSessionEntries(storePath, {
          [staleSessionKey]: {
            sessionId: "old-run",
            updatedAt: Date.now() - 8 * 24 * 60 * 60_000,
          },
        });
        const loadSnapshot = vi.fn(() => {
          throw new Error("SQLITE_CORRUPT: task-flow maintenance restore failed");
        });
        const saveSnapshot = vi.fn();
        const upsertFlow = vi.fn();
        const deleteFlow = vi.fn();
        configureTaskFlowRegistryRuntime({
          store: {
            loadSnapshot,
            saveSnapshot,
            upsertFlow,
            deleteFlow,
          },
        });
        const runtime = createRuntime();

        await expect(tasksMaintenanceCommand({ json: true, apply }, runtime)).rejects.toThrow(
          "Task-flow registry restore failed: SQLITE_CORRUPT: task-flow maintenance restore failed. Refusing task maintenance.",
        );

        expect(loadSnapshot).toHaveBeenCalledTimes(1);
        expect(saveSnapshot).not.toHaveBeenCalled();
        expect(upsertFlow).not.toHaveBeenCalled();
        expect(deleteFlow).not.toHaveBeenCalled();
        expect(runtime.log).not.toHaveBeenCalled();
        expect(loadSessionEntry({ sessionKey: staleSessionKey, storePath })).toBeDefined();
        reloadTaskRegistryFromStore();
        expect(getTaskById(staleTask.taskId)?.taskId).toBe(staleTask.taskId);
      });
    },
  );

  it("applies a conservative session registry sweep for stale cron run sessions", async () => {
    await withTaskCommandStateDir(async (state) => {
      const now = Date.now();
      const sessionsDir = state.sessionsDir("main");
      const storePath = path.join(sessionsDir, "sessions.json");
      const old = now - 8 * 24 * 60 * 60_000;
      await writeSessionEntries(storePath, {
        "agent:main:cron:done-job:run:old-run": {
          sessionId: "done-run",
          updatedAt: old,
        },
        "agent:main:cron:running-job:run:old-run": {
          sessionId: "running-run",
          updatedAt: old,
        },
        "agent:main:cron:done-job:run:recent-run": {
          sessionId: "recent-run",
          updatedAt: now - 60_000,
        },
        "agent:main:telegram:dm:old": {
          sessionId: "ordinary-old-session",
          updatedAt: old,
        },
      });
      await saveCronStore(state.statePath("cron", "jobs.json"), {
        version: 1,
        jobs: [
          {
            id: "running-job",
            name: "Running job",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            sessionKey: "cron:running-job",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "ping" },
            delivery: { mode: "none" },
            createdAtMs: now,
            updatedAtMs: now,
            state: { runningAtMs: now - 5_000 },
          },
          {
            id: "done-job",
            name: "Done job",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            sessionKey: "cron:done-job",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "ping" },
            delivery: { mode: "none" },
            createdAtMs: now,
            updatedAtMs: now,
            state: {},
          },
        ],
      });
      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: true }, runtime);

      const payload = readFirstJsonLog(runtime) as {
        maintenance: {
          sessions: {
            pruned: number;
            runningCronJobs: number;
            stores: Array<{ pruned: number; preservedRunning: number }>;
          };
        };
      };
      expect(payload.maintenance.sessions.pruned).toBe(1);
      expect(payload.maintenance.sessions.runningCronJobs).toBe(1);
      expect(payload.maintenance.sessions.stores[0]?.pruned).toBe(1);
      expect(payload.maintenance.sessions.stores[0]?.preservedRunning).toBe(1);

      expect(
        loadSessionEntry({ sessionKey: "agent:main:cron:done-job:run:old-run", storePath }),
      ).toBeUndefined();
      for (const key of [
        "agent:main:cron:running-job:run:old-run",
        "agent:main:cron:done-job:run:recent-run",
        "agent:main:telegram:dm:old",
      ]) {
        if (loadSessionEntry({ sessionKey: key, storePath }) === undefined) {
          throw new Error(`Expected preserved session ${key}`);
        }
      }
    });
  });
});
