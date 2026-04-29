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
import { tasksAuditCommand, tasksMaintenanceCommand } from "./tasks.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

async function withTaskCommandStateDir(run: () => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-tasks-command-" },
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

describe("tasks commands", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("keeps audit JSON stable and sorts combined findings before limiting", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 40 * 60_000);
      createTaskRecord({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: "task-stale-queued",
        status: "running",
        task: "Inspect issue backlog",
      });
      vi.setSystemTime(now);
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

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        summary: {
          total: number;
          errors: number;
          warnings: number;
          byCode: Record<string, number>;
          taskFlows: { total: number; byCode: Record<string, number> };
          combined: { total: number; errors: number; warnings: number };
        };
      };

      expect(payload.summary.byCode.stale_running).toBe(1);
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
      await tasksAuditCommand({ json: true, limit: 1 }, limitedRuntime);

      const limitedPayload = JSON.parse(
        String(vi.mocked(limitedRuntime.log).mock.calls[0]?.[0]),
      ) as {
        findings: Array<{ kind: string; code: string; token?: string }>;
      };

      expect(limitedPayload.findings).toHaveLength(1);
      expect(limitedPayload.findings[0]).toMatchObject({
        kind: "task_flow",
        code: "stale_running",
        token: runningFlow.flowId,
      });
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

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
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
      expect(payload.auditBefore.byCode).toBeDefined();
      expect(payload.auditBefore.taskFlows.byCode.stale_running).toBe(0);
      expect(payload.auditAfter.byCode).toBeDefined();
      expect(payload.auditAfter.taskFlows.byCode.stale_running).toBe(0);
    });
  });
});
