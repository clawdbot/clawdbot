import { afterEach, describe, expect, it } from "vitest";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
  registerContextEngineMaintenanceTaskOwner,
} from "./context-engine-maintenance-task-owner.js";
import { createRunningTaskRunCore } from "./task-executor.js";
import { getTaskById } from "./task-registry.js";
import {
  configureTaskRegistryMaintenance,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

afterEach(async () => {
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetTaskRegistryForTests({ persist: false });
  await drainGlobalSingletonLifecycleState("close");
});

describe("context-engine maintenance task ownership", () => {
  it("rechecks process ownership registered while recovery yields", async () => {
    await withStateDirEnv("openclaw-context-maintenance-race-", async () => {
      resetTaskRegistryForTests({ persist: false });
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
      const staleAt = Date.now() - 10 * 60_000;
      const task = createRunningTaskRunCore({
        runtime: "acp",
        taskKind: CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
        sourceId: CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
        requesterSessionKey: "agent:main:context-maintenance-race",
        ownerKey: "agent:main:context-maintenance-race",
        scopeKind: "session",
        runId: "turn-maint:context-maintenance-race",
        label: "Context engine turn maintenance",
        task: "Deferred context-engine maintenance after turn.",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        startedAt: staleAt,
        lastEventAt: staleAt,
      });
      if (!task) {
        throw new Error("expected process-owned maintenance task");
      }

      const maintenance = runTaskRegistryMaintenance();
      const releaseOwner = registerContextEngineMaintenanceTaskOwner(task.taskId);
      expect(await maintenance).toMatchObject({ reconciled: 0 });
      expect(getTaskById(task.taskId)?.status).toBe("running");
      releaseOwner();
    });
  });
});
