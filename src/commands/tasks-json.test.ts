import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import {
  createTaskRecord,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { tasksAuditJsonCommand, tasksListJsonCommand } from "./tasks-json.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function readJsonLog(runtime: RuntimeEnv): unknown {
  const [call] = vi.mocked(runtime.log).mock.calls;
  if (!call) {
    throw new Error("expected runtime log call");
  }
  return JSON.parse(String(call[0]));
}

async function withTaskJsonStateDir(run: () => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-tasks-json-command-" },
    async () => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run();
      } finally {
        resetTaskRegistryDeliveryRuntimeForTests();
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("tasks JSON commands", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("lists task records with runtime and status filters", async () => {
    await withTaskJsonStateDir(async () => {
      const cliTask = createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-cli",
        status: "running",
        task: "Inspect issue backlog",
      });
      createTaskRecord({
        runtime: "cron",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "run-cron",
        status: "queued",
        task: "Refresh schedule",
      });

      const runtime = createRuntime();
      await tasksListJsonCommand({ json: true, runtime: "cli", status: "running" }, runtime);

      expect(readJsonLog(runtime)).toStrictEqual({
        count: 1,
        runtime: "cli",
        status: "running",
        tasks: [JSON.parse(JSON.stringify(cliTask))],
      });
    });
  });

  it("keeps audit JSON shape and combined task-flow sorting", async () => {
    await withTaskJsonStateDir(async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 40 * 60_000);
      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-stale-running",
        status: "running",
        task: "Inspect issue backlog",
      });
      vi.setSystemTime(now);
      const runningFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-json-command",
        goal: "Running flow",
        status: "running",
        createdAt: now - 45 * 60_000,
        updatedAt: now - 45 * 60_000,
      });
      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/tasks-json-command",
        goal: "Waiting flow",
        status: "waiting",
        createdAt: now - 40 * 60_000,
        updatedAt: now - 40 * 60_000,
      });

      const runtime = createRuntime();
      await tasksAuditJsonCommand({ json: true, limit: 1 }, runtime);

      expect(readJsonLog(runtime)).toStrictEqual({
        count: 5,
        filteredCount: 5,
        displayed: 1,
        filters: {
          severity: null,
          code: null,
          limit: 1,
        },
        summary: {
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
          taskFlows: {
            total: 4,
            warnings: 2,
            errors: 2,
            byCode: {
              restore_failed: 0,
              stale_running: 1,
              stale_waiting: 1,
              stale_blocked: 0,
              cancel_stuck: 0,
              missing_linked_tasks: 2,
              blocked_task_missing: 0,
              inconsistent_timestamps: 0,
            },
          },
          combined: { total: 5, errors: 3, warnings: 2 },
        },
        findings: [
          {
            kind: "task_flow",
            severity: "error",
            code: "stale_running",
            detail: "running TaskFlow has not advanced recently",
            ageMs: 45 * 60_000,
            status: "running",
            token: runningFlow.flowId,
            flow: JSON.parse(JSON.stringify(runningFlow)),
          },
        ],
      });
    });
  });
});
