import fs from "node:fs/promises";
import path from "node:path";
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
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { tasksAuditCommand, tasksMaintenanceCommand } from "./tasks.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

const zeroTaskAuditCounts = {
  delivery_failed: 0,
  inconsistent_timestamps: 0,
  lost: 0,
  missing_cleanup: 0,
  stale_queued: 0,
  stale_running: 0,
};

async function withTaskCommandStateDir(
  run: (state: OpenClawTestState) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-tasks-command-" },
    async (state) => {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        await run(state);
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

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls.at(0)?.[0])) as {
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
      await tasksAuditCommand({ json: true, limit: 1 }, limitedRuntime);

      const limitedPayload = JSON.parse(
        String(vi.mocked(limitedRuntime.log).mock.calls.at(0)?.[0]),
      );

      expect(limitedPayload.findings).toStrictEqual([
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
      ]);
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

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls.at(0)?.[0])) as {
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

  it("applies a conservative session registry sweep for stale cron run sessions", async () => {
    await withTaskCommandStateDir(async (state) => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const sessionsDir = state.sessionsDir("main");
      const storePath = path.join(sessionsDir, "sessions.json");
      const old = now - 8 * 24 * 60 * 60_000;
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
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
          },
          null,
          2,
        ),
        "utf-8",
      );
      await state.writeJson("cron/jobs.json", {
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
            state: {},
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
      await state.writeJson("cron/jobs-state.json", {
        version: 1,
        jobs: {
          "running-job": {
            updatedAtMs: now,
            state: { runningAtMs: now - 5_000 },
          },
          "done-job": {
            updatedAtMs: now,
            state: {},
          },
        },
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ json: true, apply: true }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls.at(0)?.[0])) as {
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

      const updated = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
      expect(updated["agent:main:cron:done-job:run:old-run"]).toBeUndefined();
      for (const key of [
        "agent:main:cron:running-job:run:old-run",
        "agent:main:cron:done-job:run:recent-run",
        "agent:main:telegram:dm:old",
      ]) {
        if (updated[key] === undefined) {
          throw new Error(`Expected preserved session ${key}`);
        }
      }
    });
  });
});
