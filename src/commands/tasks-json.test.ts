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
  return JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
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
      createTaskRecord({
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

      const payload = readJsonLog(runtime) as {
        count: number;
        runtime: string | null;
        status: string | null;
        tasks: Array<{ runtime: string; status: string; runId: string }>;
      };
      expect(payload.count).toBe(1);
      expect(payload.runtime).toBe("cli");
      expect(payload.status).toBe("running");
      expect(payload.tasks).toHaveLength(1);
      expect(payload.tasks[0]?.runtime).toBe("cli");
      expect(payload.tasks[0]?.status).toBe("running");
      expect(payload.tasks[0]?.runId).toBe("run-cli");
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

      const payload = readJsonLog(runtime) as {
        count: number;
        filteredCount: number;
        displayed: number;
        filters: { limit: number | null };
        summary: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
          combined: { total: number; errors: number; warnings: number };
        };
        findings: Array<{ kind: string; code: string; token?: string }>;
      };
      expect(payload.count).toBe(5);
      expect(payload.filteredCount).toBe(5);
      expect(payload.displayed).toBe(1);
      expect(payload.filters.limit).toBe(1);
      expect(payload.summary.byCode.stale_running).toBe(1);
      expect(payload.summary.taskFlows.byCode.stale_running).toBe(1);
      expect(payload.summary.taskFlows.byCode.stale_waiting).toBe(1);
      expect(payload.summary.taskFlows.byCode.missing_linked_tasks).toBe(2);
      expect(payload.summary.combined).toEqual({ total: 5, errors: 3, warnings: 2 });
      expect(payload.findings).toHaveLength(1);
      expect(payload.findings[0]?.kind).toBe("task_flow");
      expect(payload.findings[0]?.code).toBe("stale_running");
      expect(payload.findings[0]?.token).toBe(runningFlow.flowId);
    });
  });
});
