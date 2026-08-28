import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAllLanes } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  getTaskFlowById,
  reloadTaskFlowRegistryFromStore,
} from "../../tasks/task-flow-registry.js";
import {
  getTaskById,
  listTasksForOwnerKey,
  reloadTaskRegistryFromStore,
} from "../../tasks/task-registry.js";
import {
  configureTaskRegistryMaintenance,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
} from "../../tasks/task-registry.maintenance.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";

const CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";

afterEach(async () => {
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetCommandQueueStateForTest();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await drainGlobalSingletonLifecycleState("close");
  vi.useRealTimers();
});

describe("deferred context-engine maintenance lifecycle", () => {
  it("retains live work across restart and loses it after the owning process closes", async () => {
    await withStateDirEnv("openclaw-context-maintenance-lifecycle-", async () => {
      vi.useFakeTimers();
      resetCommandQueueStateForTest();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });

      const sessionKey = "agent:main:context-maintenance-lifecycle";
      let releaseMaintenance: (() => void) | undefined;
      let deferredMaintenance: Promise<void> | undefined;
      await runContextEngineMaintenance({
        contextEngine: {
          info: {
            id: "lifecycle-test",
            name: "Lifecycle test",
            turnMaintenanceMode: "background",
          },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
          compact: async () => ({ ok: true, compacted: false }),
          maintain: async () => {
            await new Promise<void>((resolve) => {
              releaseMaintenance = resolve;
            });
            return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
          },
        },
        sessionId: "context-maintenance-lifecycle",
        sessionKey,
        sessionFile: "/tmp/context-maintenance-lifecycle.jsonl",
        reason: "turn",
        onDeferredMaintenance: (promise) => {
          deferredMaintenance = promise;
        },
      });

      await vi.advanceTimersByTimeAsync(11_000);
      const task = listTasksForOwnerKey(sessionKey).find(
        (candidate) =>
          candidate.taskKind === CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND &&
          candidate.parentFlowId,
      );
      if (!task?.parentFlowId) {
        throw new Error("expected visible deferred maintenance with a TaskFlow");
      }
      const flowId = task.parentFlowId;
      expect(getTaskFlowById(flowId)?.status).toBe("running");

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      resetAllLanes();
      await drainGlobalSingletonLifecycleState("restart");
      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
      expect(getTaskById(task.taskId)?.status).toBe("running");
      expect(getTaskFlowById(flowId)?.status).toBe("running");

      await drainGlobalSingletonLifecycleState("close");
      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
      const lostTask = getTaskById(task.taskId);
      const lostFlow = getTaskFlowById(flowId);
      expect(lostTask).toMatchObject({
        status: "lost",
        error: "owning process exited",
        endedAt: expect.any(Number),
        lastEventAt: expect.any(Number),
        cleanupAfter: expect.any(Number),
      });
      expect(lostFlow).toMatchObject({
        status: "lost",
        endedAt: lostTask?.endedAt,
        updatedAt: lostTask?.endedAt,
      });

      reloadTaskRegistryFromStore();
      reloadTaskFlowRegistryFromStore();
      const durableTask = getTaskById(task.taskId);
      const durableFlow = getTaskFlowById(flowId);
      expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
      expect(getTaskById(task.taskId)).toMatchObject({
        status: "lost",
        endedAt: durableTask?.endedAt,
        lastEventAt: durableTask?.lastEventAt,
        cleanupAfter: durableTask?.cleanupAfter,
      });
      expect(getTaskFlowById(flowId)).toMatchObject({
        status: "lost",
        endedAt: durableFlow?.endedAt,
        updatedAt: durableFlow?.updatedAt,
      });

      releaseMaintenance?.();
      await deferredMaintenance;
    });
  });
});
